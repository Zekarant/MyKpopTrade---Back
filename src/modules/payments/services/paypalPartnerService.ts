import axios from 'axios';
import { randomUUID } from 'crypto';
import User, { IUser } from '../../../models/userModel';
import { paypalApiBaseUrl, PayPalClient, partnerHeaders, extractDebugId } from './paypalClient';
import { paymentConfig } from '../../../config/paymentConfig';
import env from '../../../config/env';
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

/** Langue des écrans d'onboarding PayPal. La plateforme est franco-française. */
const ONBOARDING_LANGUAGE = 'fr-FR';

/**
 * Volume de vente mensuel déclaré par défaut pour tous les vendeurs — cohérent
 * avec un usage C2C occasionnel. Évite à PayPal de demander ce champ au
 * vendeur (vérifié acceptable par l'API sandbox, cf. `business_entity`
 * ci-dessous).
 */
const SELLER_MONTHLY_VOLUME_RANGE = {
  minimum_amount: { currency_code: 'EUR', value: '0' },
  maximum_amount: { currency_code: 'EUR', value: '10000' }
};

/**
 * Merchant Category Code déclaré pour tous les vendeurs — même code que le
 * `business_profile.mcc` envoyé à Stripe (cf. stripeConnectService.ts).
 * « Hobby, Toy, and Game Shops » (Magasins de loisirs, jouets et jeux) : le
 * plus proche de la revente de cartes/goodies K-pop entre particuliers,
 * confirmé présent dans la vraie liste MCC du dropdown PayPal.
 */
const SELLER_MCC = '5945';

/**
 * Découpe un numéro français au format attendu par PayPal
 * (`{ country_code, national_number }`).
 *
 * Renvoie `null` dès que le numéro n'est pas reconnaissable : un numéro invalide
 * ferait échouer la « create partner referral » entière, alors que l'absence de
 * pré-remplissage ne coûte qu'un champ à ressaisir.
 */
export function parseFrenchPhone(raw?: string): { country_code: string; national_number: string } | null {
  if (!raw) return null;

  const digits = raw.replace(/\D/g, '');
  let national: string | null = null;
  if (digits.startsWith('0033')) national = digits.slice(4);
  else if (digits.startsWith('33')) national = digits.slice(2);
  else if (digits.startsWith('0')) national = digits.slice(1);

  return national && /^\d{9}$/.test(national)
    ? { country_code: '33', national_number: national }
    : null;
}

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
    const seller = await User.findById(sellerId).select(
      'username email phoneNumber paypalTrackingId legalName address'
    );
    if (!seller) {
      throw new Error('Vendeur non trouvé');
    }

    const trackingId = `${sellerId}-${randomUUID().slice(0, 8)}`;
    const accessToken = await PayPalClient.getAccessToken();

    // Pré-remplissage : PayPal ne présente un formulaire allégé au vendeur que si
    // le partenaire lui transmet les données qu'il détient déjà. `legalName` et
    // `address` sont facultatifs (renseignés par le vendeur dans ses paramètres,
    // cf. authProfileService.ts) — s'ils sont absents, PayPal les redemande
    // normalement à l'onboarding, sans bloquer.
    const body: Record<string, unknown> = {
      tracking_id: trackingId,
      email: seller.email,
      preferred_language_code: ONBOARDING_LANGUAGE,
      // Pays de constitution/résidence légale — sans ça, PayPal semble le
      // déduire du compte personnel utilisé pour se connecter (vu en sandbox :
      // un testeur belge se voit proposer « Belgique » par défaut). La
      // plateforme n'opère qu'en France.
      legal_country_code: 'FR',
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
      legal_consents: [{ type: 'SHARE_DATA_CONSENT', granted: true }],
      // `business_type: INDIVIDUAL` + volume/site déjà connus par la
      // plateforme évitent à PayPal de les redemander au vendeur (formulaire
      // « Devise / Ventes mensuelles / Site web » vu à l'onboarding) — vérifié
      // accepté par l'API sandbox (`names` n'est pas requis pour un compte
      // INDIVIDUAL). Pour le secteur d'activité, seul `mcc_code` est envoyé
      // (`5945` = Hobby, Toy, and Game Shops — même code que côté Stripe, cf.
      // stripeConnectService.ts) : `category`/`subcategory` ont été retirés
      // après avoir constaté en sandbox qu'ils font afficher un secteur sans
      // rapport (ex. « Électriciens ») quand on leur donne un code MCC —
      // ce sont visiblement des champs distincts, pas de table de
      // correspondance publique connue pour eux. Le dropdown « Que vendez-vous »
      // du formulaire PayPal est, lui, directement indexé par code MCC
      // standard (vérifié via le DOM du composant réel).
      business_entity: {
        business_type: { type: 'INDIVIDUAL' },
        website: env.MARKETPLACE_URL,
        average_monthly_volume_range: SELLER_MONTHLY_VOLUME_RANGE,
        business_industry: { mcc_code: SELLER_MCC },
        // Adresse visible par les clients (factures, relevés) — l'email de
        // support de la plateforme, pas celui du vendeur.
        emails: [{ email: env.SUPPORT_EMAIL, type: 'CUSTOMER_SERVICE' }]
      }
    };

    const businessEntity = body.business_entity as Record<string, unknown>;
    const individualOwner: Record<string, unknown> = { type: 'PRIMARY' };

    // Le pseudo n'est qu'un nom d'usage (DOING_BUSINESS_AS), pas une identité
    // légale : il remplit « Nom commercial (facultatif) » sans risque, contrairement
    // au nom légal ci-dessous, requis pour le champ obligatoire « Nom de
    // l'entreprise » et donc réservé aux vendeurs l'ayant explicitement déclaré.
    const businessNames: Array<{ business_name: string; type: string }> = [
      { business_name: seller.username, type: 'DOING_BUSINESS_AS' }
    ];

    // Nom légal auto-déclaré par le vendeur (paramètres du profil) — remplit
    // le champ obligatoire « Nom de l'entreprise » côté business_entity ET le
    // nom légal individuel, pour un compte INDIVIDUAL où les deux se
    // confondent (un vendeur particulier n'a pas de raison sociale distincte).
    if (seller.legalName) {
      businessNames.push({ business_name: seller.legalName, type: 'LEGAL_NAME' });

      // `full_name` seul ne suffit pas : certaines variantes du formulaire
      // PayPal affichent Prénom/Nom en deux champs séparés, qui restent vides
      // si on n'envoie pas `given_name`/`surname` — vérifié en sandbox.
      // MyKpopTrade ne stocke qu'un nom complet : on le découpe au premier
      // espace (dernier recours si un seul mot : même valeur des deux côtés,
      // pour qu'aucun des deux champs ne reste vide).
      const [givenName, ...rest] = seller.legalName.trim().split(/\s+/);
      const surname = rest.join(' ') || givenName;
      individualOwner.names = [{
        given_name: givenName,
        surname,
        full_name: seller.legalName,
        type: 'LEGAL'
      }];
    }

    businessEntity.names = businessNames;

    // Adresse structurée auto-déclarée — remplit « Adresse du siège social ».
    // `type` diffère entre les deux objets : `WORK` pour business_entity,
    // `HOME` pour individual_owners (`WORK` y est rejeté avec 400 — vérifié
    // contre l'API sandbox).
    if (seller.address) {
      const portableAddress = {
        address_line_1: seller.address.streetLine1,
        address_line_2: seller.address.streetLine2,
        admin_area_2: seller.address.city,
        postal_code: seller.address.postalCode,
        country_code: seller.address.country
      };
      businessEntity.addresses = [{ ...portableAddress, type: 'WORK' }];
      individualOwner.addresses = [{ ...portableAddress, type: 'HOME' }];
    }

    // Le téléphone décrit la personne, pas une société : il va dans
    // `individual_owners`, dont l'enum accepte MOBILE (`business_entity.phones`
    // n'accepte que CUSTOMER_SERVICE/BUSINESS — vérifié contre l'API sandbox).
    const phone = parseFrenchPhone(seller.phoneNumber);
    if (phone) {
      individualOwner.phones = [{ ...phone, type: 'MOBILE' }];
    }

    if (Object.keys(individualOwner).length > 1) {
      body.individual_owners = [individualOwner];
    }

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
