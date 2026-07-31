import axios from 'axios';
import { randomUUID } from 'crypto';
import User, { IUser } from '../../../models/userModel';
import { paypalApiBaseUrl, PayPalClient, partnerHeaders, extractDebugId } from './paypalClient';
import { paymentConfig } from '../../../config/paymentConfig';
import logger from '../../../commons/utils/logger';

/**
 * Features demandées au vendeur lors de l'onboarding.
 *
 * - PAYMENT / REFUND : encaisser et rembourser en son nom.
 * - PARTNER_FEE      : prélever une commission via `platform_fees`. Demandé dès
 *                      maintenant même si la commission est à 0 en beta, pour
 *                      ne pas avoir à ré-onboarder les vendeurs à l'activation.
 *
 * L'IWT exige que ces features correspondent à la Solution Design validée avec
 * PayPal — à confirmer avec l'Integration Engineer avant le passage en live.
 */
const REQUESTED_FEATURES = ['PAYMENT', 'REFUND', 'PARTNER_FEE'] as const;

const SELLER_STATUS_STALE_MS = 15 * 60 * 1000;

export interface SellerStatus {
  merchantId: string;
  paymentsReceivable: boolean;
  primaryEmailConfirmed: boolean;
  consentGranted: boolean;
  scopes: string[];
  /**
   * « Show seller status » ne renvoie pas l'email du vendeur — seulement
   * `legal_name`. On l'utilise pour lui confirmer quel compte PayPal est relié.
   */
  legalName: string | null;
  primaryEmail: string | null;
}

/**
 * Raison précise pour laquelle un vendeur ne peut pas encaisser. Le front s'en
 * sert pour afficher le message d'action attendu par l'IWT.
 */
export type SellerBlockReason =
  | 'NOT_ONBOARDED'
  | 'STATUS_UNKNOWN'
  | 'EMAIL_UNCONFIRMED'
  | 'PAYMENTS_NOT_RECEIVABLE'
  | 'CONSENT_MISSING';

/**
 * Onboarding des vendeurs via l'API Partner Referrals (Connected Path).
 *
 * Le vendeur ne confie jamais ses identifiants à MyKpopTrade : il est redirigé
 * vers PayPal, accorde ses permissions à la plateforme, et revient avec un
 * `merchantIdInPayPal`. Toutes les opérations ultérieures (order, capture,
 * refund) passent par le token plateforme + le header `PayPal-Auth-Assertion`.
 */
export class PayPalPartnerService {
  /**
   * Génère un lien d'inscription PayPal pour un vendeur.
   * Un `tracking_id` neuf est émis à chaque appel : PayPal refuse de réutiliser
   * un tracking_id déjà consommé, et les action URLs ne doivent jamais être
   * partagées entre vendeurs.
   */
  static async createOnboardingLink(sellerId: string): Promise<string> {
    const seller = await User.findById(sellerId).select('email paypalTrackingId');
    if (!seller) {
      throw new Error('Vendeur non trouvé');
    }

    const trackingId = `${sellerId}-${randomUUID().slice(0, 8)}`;
    const accessToken = await PayPalClient.getAccessToken();

    const body = {
      tracking_id: trackingId,
      email: seller.email,
      partner_config_override: {
        return_url: PayPalPartnerService.returnUrl(),
        return_url_description:
          'Revenir sur MyKpopTrade pour finaliser la configuration de votre boutique.'
      },
      operations: [
        {
          operation: 'API_INTEGRATION',
          api_integration_preference: {
            rest_api_integration: {
              integration_method: 'PAYPAL',
              integration_type: 'THIRD_PARTY',
              third_party_details: { features: [...REQUESTED_FEATURES] }
            }
          }
        }
      ],
      products: ['PPCP'],
      legal_consents: [{ type: 'SHARE_DATA_CONSENT', granted: true }]
    };

    try {
      const response = await axios.post(
        `${paypalApiBaseUrl}/v2/customer/partner-referrals`,
        body,
        { headers: partnerHeaders({ accessToken }) }
      );

      const actionUrl = response.data.links?.find(
        (link: any) => link.rel === 'action_url'
      )?.href;

      if (!actionUrl) {
        throw new Error('PayPal n\'a pas renvoyé d\'action_url dans la réponse partner-referrals');
      }

      seller.paypalTrackingId = trackingId;
      await seller.save();

      logger.info('Lien d\'onboarding PayPal généré', {
        sellerId: sellerId.substring(0, 5) + '...',
        trackingId,
        features: REQUESTED_FEATURES
      });

      return actionUrl;
    } catch (error: any) {
      logger.error('Échec de la création du partner referral PayPal', {
        sellerId: sellerId.substring(0, 5) + '...',
        status: error.response?.status,
        message: error.response?.data?.message || error.message,
        debugId: extractDebugId(error)
      });
      throw new Error('Impossible de générer le lien d\'inscription PayPal');
    }
  }

  /**
   * Interroge « show seller status » pour un merchant ID donné.
   * Renvoie `null` si PayPal ne connaît pas encore ce vendeur (404).
   */
  static async fetchSellerStatus(merchantId: string): Promise<SellerStatus | null> {
    const partnerId = paymentConfig.paypal.partnerMerchantId;
    if (!partnerId) {
      throw new Error('PAYPAL_PARTNER_MERCHANT_ID non configuré');
    }

    const accessToken = await PayPalClient.getAccessToken();

    try {
      const response = await axios.get(
        `${paypalApiBaseUrl}/v1/customer/partners/${partnerId}/merchant-integrations/${merchantId}`,
        { headers: partnerHeaders({ accessToken }) }
      );

      const data = response.data;

      // Les permissions accordées à la plateforme vivent dans
      // oauth_integrations[].oauth_third_party[].scopes. Un tableau vide
      // signifie que le vendeur n'a pas validé l'étape de consentement.
      const scopes: string[] = (data.oauth_integrations || []).flatMap((integration: any) =>
        (integration.oauth_third_party || []).flatMap((party: any) => party.scopes || [])
      );

      return {
        merchantId: data.merchant_id || merchantId,
        paymentsReceivable: Boolean(data.payments_receivable),
        primaryEmailConfirmed: Boolean(data.primary_email_confirmed),
        consentGranted: (data.oauth_integrations || []).length > 0,
        scopes,
        legalName: data.legal_name || null,
        primaryEmail: data.primary_email || null
      };
    } catch (error: any) {
      if (error.response?.status === 404) {
        logger.warn('Vendeur inconnu de PayPal', {
          merchantId: merchantId.substring(0, 5) + '...'
        });
        return null;
      }
      logger.error('Échec de « show seller status »', {
        merchantId: merchantId.substring(0, 5) + '...',
        status: error.response?.status,
        message: error.response?.data?.message || error.message,
        debugId: extractDebugId(error)
      });
      throw new Error('Impossible de récupérer le statut PayPal du vendeur');
    }
  }

  /**
   * Rafraîchit et persiste le statut d'onboarding d'un vendeur.
   * Appelé au retour d'onboarding, sur consultation du dashboard vendeur, et
   * avant chaque création d'ordre si l'instantané est périmé.
   */
  static async refreshSellerStatus(sellerId: string): Promise<SellerStatus | null> {
    const seller = await User.findById(sellerId).select(
      'paypalMerchantId paypalEmail paypalConnected paypalOnboarding'
    );
    if (!seller?.paypalMerchantId) {
      return null;
    }

    const status = await PayPalPartnerService.fetchSellerStatus(seller.paypalMerchantId);
    if (!status) {
      return null;
    }

    seller.paypalOnboarding = {
      paymentsReceivable: status.paymentsReceivable,
      primaryEmailConfirmed: status.primaryEmailConfirmed,
      consentGranted: status.consentGranted,
      scopes: status.scopes,
      legalName: status.legalName || undefined,
      checkedAt: new Date()
    };
    // L'IWT demande d'afficher au vendeur l'email de son compte PayPal.
    if (status.primaryEmail) {
      seller.paypalEmail = status.primaryEmail;
    }
    seller.paypalConnected = PayPalPartnerService.isReady(status);
    await seller.save();

    return status;
  }

  /**
   * Enregistre le merchant ID renvoyé par PayPal au retour d'onboarding, puis
   * vérifie le statut réel côté API.
   *
   * Les query params du retour ne sont pas dignes de confiance (l'URL transite
   * par le navigateur du vendeur) : seul l'appel « show seller status » fait foi.
   */
  static async completeOnboarding(
    sellerId: string,
    merchantIdInPayPal: string
  ): Promise<SellerStatus | null> {
    const seller = await User.findById(sellerId);
    if (!seller) {
      throw new Error('Vendeur non trouvé');
    }

    // Le merchant ID est persisté AVANT d'interroger PayPal, et l'échec de
    // l'interrogation n'est pas propagé. PayPal ne communique cet identifiant
    // qu'une seule fois (retour d'onboarding + webhook) et ne permet pas de le
    // retrouver ensuite : le perdre obligerait le vendeur à refaire tout son
    // parcours. Le statut, lui, se rattrape à tout moment.
    seller.paypalMerchantId = merchantIdInPayPal;
    seller.paypalConnected = false;
    await seller.save();

    let status: SellerStatus | null;
    try {
      status = await PayPalPartnerService.fetchSellerStatus(merchantIdInPayPal);
    } catch (error) {
      logger.error('Merchant ID enregistré mais statut PayPal non vérifiable', {
        sellerId: sellerId.substring(0, 5) + '...',
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }

    if (!status) {
      logger.warn('Retour d\'onboarding avec un merchant ID inconnu de PayPal', {
        sellerId: sellerId.substring(0, 5) + '...'
      });
      return null;
    }

    seller.paypalMerchantId = status.merchantId;
    seller.paypalEmail = status.primaryEmail || undefined;
    seller.paypalOnboarding = {
      paymentsReceivable: status.paymentsReceivable,
      primaryEmailConfirmed: status.primaryEmailConfirmed,
      consentGranted: status.consentGranted,
      scopes: status.scopes,
      legalName: status.legalName || undefined,
      checkedAt: new Date()
    };
    seller.paypalConnected = PayPalPartnerService.isReady(status);
    await seller.save();

    logger.info('Onboarding PayPal enregistré', {
      sellerId: sellerId.substring(0, 5) + '...',
      ready: seller.paypalConnected,
      paymentsReceivable: status.paymentsReceivable,
      primaryEmailConfirmed: status.primaryEmailConfirmed,
      consentGranted: status.consentGranted
    });

    return status;
  }

  /** Un vendeur ne peut transiger que si les trois conditions sont réunies. */
  static isReady(status: SellerStatus): boolean {
    return status.paymentsReceivable && status.primaryEmailConfirmed && status.consentGranted;
  }

  /**
   * Vérifie qu'un vendeur peut encaisser, en rafraîchissant le statut si
   * l'instantané local date de plus de 15 minutes.
   * Renvoie `null` si tout est bon, sinon la raison du blocage.
   */
  static async assertSellerCanTransact(seller: IUser): Promise<SellerBlockReason | null> {
    if (!seller.paypalMerchantId) {
      return 'NOT_ONBOARDED';
    }

    let snapshot = seller.paypalOnboarding;
    const checkedAt = snapshot?.checkedAt ? new Date(snapshot.checkedAt).getTime() : 0;

    if (Date.now() - checkedAt > SELLER_STATUS_STALE_MS) {
      const refreshed = await PayPalPartnerService.refreshSellerStatus(
        (seller._id as any).toString()
      );
      if (!refreshed) {
        return 'NOT_ONBOARDED';
      }
      snapshot = {
        paymentsReceivable: refreshed.paymentsReceivable,
        primaryEmailConfirmed: refreshed.primaryEmailConfirmed,
        consentGranted: refreshed.consentGranted,
        scopes: refreshed.scopes,
        checkedAt: new Date()
      };
    }

    if (!snapshot?.consentGranted) return 'CONSENT_MISSING';
    if (!snapshot.primaryEmailConfirmed) return 'EMAIL_UNCONFIRMED';
    if (!snapshot.paymentsReceivable) return 'PAYMENTS_NOT_RECEIVABLE';

    return null;
  }

  /**
   * « Oublie » le compte PayPal d'un vendeur. MyKpopTrade ne peut pas révoquer
   * formellement les permissions côté PayPal ; on efface donc l'association
   * pour qu'il puisse en relier une autre (cf. Integration Guide, Onboarding).
   */
  static async forgetSellerAccount(sellerId: string): Promise<void> {
    await User.findByIdAndUpdate(sellerId, {
      paypalConnected: false,
      $unset: {
        paypalMerchantId: 1,
        paypalTrackingId: 1,
        paypalOnboarding: 1,
        paypalEmail: 1
      }
    });
  }

  private static returnUrl(): string {
    const baseUrl =
      process.env.PAYPAL_OAUTH_BASE_URL || process.env.API_URL || 'http://localhost:3000';
    return `${baseUrl}/api/payments/paypal/onboarding-return`;
  }
}

/** Messages destinés au vendeur, formulés comme l'exige l'IWT. */
export const SELLER_BLOCK_MESSAGES: Record<SellerBlockReason, string> = {
  NOT_ONBOARDED:
    'Connectez votre compte PayPal pour pouvoir vendre sur MyKpopTrade.',
  STATUS_UNKNOWN:
    'Votre compte PayPal est bien relié, mais nous n\'avons pas encore pu vérifier son état. Cliquez sur « Rafraîchir mon statut ».',
  EMAIL_UNCONFIRMED:
    'Confirmez votre adresse e-mail sur paypal.com pour pouvoir recevoir des paiements. Revenez ensuite sur cette page pour rafraîchir votre statut.',
  PAYMENTS_NOT_RECEIVABLE:
    'Vous ne pouvez pas recevoir de paiements en raison d\'une restriction possible sur votre compte PayPal. Contactez le support PayPal ou connectez-vous sur paypal.com pour en savoir plus. Une fois réglé, revenez sur cette page pour rafraîchir votre statut.',
  CONSENT_MISSING:
    'Votre inscription PayPal est incomplète : les permissions n\'ont pas été accordées à MyKpopTrade. Relancez la connexion PayPal et acceptez le partage des autorisations.'
};
