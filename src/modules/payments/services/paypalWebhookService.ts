import Payment, { IPayment } from '../../../models/paymentModel';
import Product from '../../../models/productModel';
import User from '../../../models/userModel';
import { PayPalPartnerService } from './paypalPartnerService';
import { applyRefundToPayment, notifyRefund } from './refundLedger';
import { completePayment } from './paymentCompletion';
import { NotificationService } from '../../notifications/services/notificationService';
import logger from '../../../commons/utils/logger';
import { toCents } from '../../../commons/utils/moneyMath';
import { dispatchAdminAlert } from '../../../commons/services/adminAlertService';
import { PayPalLink, PayPalMoney } from './paypalClient';

/**
 * Ressource d'un webhook PayPal. Sa forme dépend de `event_type` (capture,
 * remboursement ou marchand) : seuls les champs exploités sont décrits.
 */
interface PayPalWebhookResource {
  id?: string;
  invoice_id?: string;
  custom_id?: string;
  supplementary_data?: { related_ids?: { order_id?: string } };
  links?: PayPalLink[];
  amount?: PayPalMoney;
  merchant_id?: string;
  tracking_id?: string;
}

export interface PayPalWebhookEvent {
  event_type: string;
  resource: PayPalWebhookResource;
}

/**
 * La capture porte-t-elle exactement le montant et la devise de la commande ?
 * Un écart (ordre modifié côté PayPal, rapprochement sur le mauvais paiement)
 * ne doit jamais vendre le produit pour une somme qu'on n'a pas facturée.
 */
function isCapturedAmountExpected(
  captured: PayPalMoney | undefined,
  payment: Pick<IPayment, 'amount' | 'currency'>
): boolean {
  const capturedValue = Number.parseFloat(captured?.value ?? '');
  return Number.isFinite(capturedValue) &&
    captured?.currency_code === payment.currency &&
    toCents(capturedValue) === toCents(payment.amount);
}

function alertCapturedAmountMismatch(
  payment: Pick<IPayment, '_id' | 'amount' | 'currency'>,
  captured: PayPalMoney | undefined,
  orderId: string
): void {
  const capturedLabel = captured ? `${captured.value} ${captured.currency_code}` : 'absent';
  logger.error('Webhook de capture ignoré : montant capturé différent du paiement', {
    paymentId: payment._id,
    orderId,
    expected: `${payment.amount} ${payment.currency}`,
    captured: capturedLabel
  });

  dispatchAdminAlert({
    event: 'payment.capture_amount_mismatch',
    severity: 'critical',
    title: 'Montant capturé par PayPal différent de la commande',
    summary: `PayPal a encaissé ${capturedLabel} au lieu de ${payment.amount} ${payment.currency} : le paiement n'a pas été finalisé, vérifiez la transaction.`,
    adminTab: 'audit',
    fields: [
      { name: 'Attendu', value: `${payment.amount} ${payment.currency}`, inline: true },
      { name: 'Capturé', value: capturedLabel, inline: true },
      { name: 'Order PayPal', value: orderId, inline: true }
    ],
    data: { paymentId: payment._id, orderId }
  });
}

/**
 * Dispatcher + handlers des webhooks PayPal.
 * Chaque handler met à jour l'état métier (paiement, produit, conversation, notif).
 */
export class PayPalWebhookService {
  /**
   * Traite le webhook PayPal pour gérer les événements de paiement
   */
  static async handleWebhook(event: PayPalWebhookEvent): Promise<void> {
    try {
      switch (event.event_type) {
        // L'acheteur a approuvé sur PayPal, mais aucun fonds n'a bougé : la
        // capture reste à faire. Marquer le paiement « completed » ici
        // vendrait le produit et notifierait le vendeur sans encaissement.
        case 'CHECKOUT.ORDER.APPROVED':
          logger.debug('Ordre approuvé par l\'acheteur, en attente de capture', {
            orderId: event.resource?.id
          });
          break;

        case 'PAYMENT.CAPTURE.COMPLETED':
          await PayPalWebhookService.handlePaymentCompleted(event);
          break;

        case 'PAYMENT.CAPTURE.REFUNDED':
          await PayPalWebhookService.handleRefund(event);
          break;

        case 'PAYMENT.CAPTURE.DENIED':
          await PayPalWebhookService.handleCaptureDenied(event);
          break;

        case 'MERCHANT.ONBOARDING.COMPLETED':
          await PayPalWebhookService.handleOnboardingCompleted(event);
          break;

        case 'MERCHANT.PARTNER-CONSENT.REVOKED':
          await PayPalWebhookService.handleConsentRevoked(event);
          break;

        // PayPal a fait évoluer les produits/capacités du compte vendeur
        // (validation en cours, capacité activée ou refusée). Le guide demande
        // de re-vérifier son éligibilité à réception.
        case 'CUSTOMER.MERCHANT-INTEGRATION.PRODUCT-SUBSCRIPTION-UPDATED':
        case 'CUSTOMER.MERCHANT-INTEGRATION.CAPABILITY-UPDATED':
          await PayPalWebhookService.handleMerchantIntegrationUpdated(event);
          break;

        default:
          logger.debug('Type d\'événement webhook non traité', { eventType: event.event_type });
          break;
      }
    } catch (error) {
      logger.error('Erreur lors du traitement du webhook PayPal', {
        error: error instanceof Error ? error.message : String(error),
        eventType: event.event_type
      });
      throw error;
    }
  }

  /**
   * Traite `PAYMENT.CAPTURE.COMPLETED` — les fonds sont effectivement encaissés.
   */
  private static async handlePaymentCompleted(event: PayPalWebhookEvent): Promise<void> {
    try {
      const resource = event.resource;
      // Sur un événement de capture, `resource.id` est l'ID de la CAPTURE.
      // L'ordre se trouve dans supplementary_data — le confondre avec l'ordre
      // fait échouer la recherche du paiement, et le captureId n'est alors
      // jamais enregistré, ce qui rend tout remboursement impossible.
      const captureId = resource.id;
      const orderId = resource.supplementary_data?.related_ids?.order_id ||
        resource.invoice_id ||
        resource.custom_id;

      if (!orderId) {
        logger.warn('Impossible de déterminer l\'orderId dans l\'événement de capture', {
          captureId
        });
        return;
      }

      const payment = await Payment.findOne({ paymentIntentId: orderId });

      if (!payment) {
        logger.warn('Aucun paiement trouvé pour l\'orderId', { orderId });
        return;
      }

      if (!isCapturedAmountExpected(resource.amount, payment)) {
        alertCapturedAmountMismatch(payment, resource.amount, orderId);
        return;
      }

      await completePayment(payment._id, captureId);
    } catch (error) {
      logger.error('Erreur lors du traitement de l\'événement de paiement complété', { error });
      throw error;
    }
  }

  /**
   * Traite les événements de remboursement (PAYMENT.CAPTURE.REFUNDED).
   * Idempotent : si le refundId est déjà marqué « completed » dans
   * l'historique, on ne refait rien (PayPal peut redélivrer le webhook).
   */
  private static async handleRefund(event: PayPalWebhookEvent): Promise<void> {
    try {
      const resource = event.resource;
      // PAYMENT.CAPTURE.REFUNDED porte toujours l'id, les liens et le montant du remboursement.
      const captureId = resource.links!.find((link) => link.rel === 'up')?.href.split('/').pop();

      if (!captureId) {
        logger.warn('Impossible de déterminer le captureId dans l\'événement de remboursement', {
          resourceId: resource.id
        });
        return;
      }

      const payment = await Payment.findOne({ captureId });

      if (!payment) {
        logger.warn('Aucun paiement trouvé pour le captureId', { captureId });
        return;
      }

      const refundAmount = parseFloat(resource.amount!.value);
      const refundCurrency = resource.amount!.currency_code;
      const refundId = resource.id!;

      // Même registre que le remboursement synchrone : idempotent par refundId,
      // donc un webhook redélivré ne double ni le montant ni les notifications.
      const ledger = applyRefundToPayment(payment, {
        refundId,
        amount: refundAmount,
        currency: refundCurrency
      });

      if (!ledger.changed) {
        logger.debug('Webhook de remboursement déjà traité, ignoré', { refundId });
        return;
      }

      await payment.save();

      if (ledger.isFullyRefunded) {
        await Product.findByIdAndUpdate(payment.product, {
          isAvailable: true,
          isSold: false,
          soldAt: null,
          soldTo: null
        });
      }

      await notifyRefund(payment, refundAmount, ledger);
    } catch (error) {
      logger.error('Erreur lors du traitement de l\'événement de remboursement', { error });
      throw error;
    }
  }

  /**
   * Le vendeur a terminé son inscription PayPal. On rapproche via le
   * `tracking_id` envoyé dans la « create partner referral », puis on
   * synchronise le statut réel : le webhook signale la fin du parcours, pas
   * forcément qu'il peut encaisser (email non confirmé, compte restreint…).
   */
  private static async handleOnboardingCompleted(event: PayPalWebhookEvent): Promise<void> {
    const { merchant_id: merchantId, tracking_id: trackingId } = event.resource || {};

    if (!merchantId) {
      logger.warn('MERCHANT.ONBOARDING.COMPLETED sans merchant_id');
      return;
    }

    const seller = trackingId
      ? await User.findOne({ paypalTrackingId: trackingId })
      : await User.findOne({ paypalMerchantId: merchantId });

    if (!seller) {
      logger.warn('Onboarding PayPal terminé pour un vendeur inconnu', { trackingId });
      return;
    }

    const status = await PayPalPartnerService.completeOnboarding(
      seller._id.toString(),
      merchantId,
      trackingId
    );

    if (PayPalPartnerService.isReady(status)) {
      await NotificationService.createNotification({
        recipientId: seller._id,
        type: 'system',
        title: 'Compte PayPal connecté',
        content: 'Votre compte PayPal est configuré : vous pouvez désormais recevoir des paiements sur MyKpopTrade.',
        link: '/settings',
        data: { paypalConnected: true }
      });
    }
  }

  /**
   * PayPal a modifié les produits ou capacités du compte vendeur. On resynchronise
   * son statut : c'est ce qui fait passer un vendeur de « en cours de validation »
   * à « peut encaisser » sans qu'il ait à revenir cliquer lui-même.
   */
  private static async handleMerchantIntegrationUpdated(event: PayPalWebhookEvent): Promise<void> {
    const merchantId = event.resource?.merchant_id;

    if (!merchantId) {
      logger.warn('Mise à jour d\'intégration marchand sans merchant_id', {
        eventType: event.event_type
      });
      return;
    }

    const seller = await User.findOne({ paypalMerchantId: merchantId }).select('_id');
    if (!seller) {
      // Cas normal pendant l'onboarding : PayPal peut émettre cet événement
      // avant que MERCHANT.ONBOARDING.COMPLETED n'ait enregistré le merchant ID.
      logger.debug('Mise à jour d\'intégration pour un marchand non encore enregistré', {
        merchantId: merchantId.substring(0, 5) + '...'
      });
      return;
    }

    const status = await PayPalPartnerService.refreshSellerStatus(
      seller._id.toString()
    );

    logger.info('Statut vendeur resynchronisé après mise à jour PayPal', {
      sellerId: seller._id.toString().substring(0, 5) + '...',
      eventType: event.event_type,
      ready: status ? PayPalPartnerService.isReady(status) : false
    });
  }

  /**
   * Le vendeur a révoqué les permissions accordées à MyKpopTrade depuis son
   * espace PayPal. Plus aucune capture ni remboursement n'est possible en son
   * nom : on coupe immédiatement PayPal pour ce vendeur.
   */
  private static async handleConsentRevoked(event: PayPalWebhookEvent): Promise<void> {
    const { merchant_id: merchantId } = event.resource || {};

    if (!merchantId) {
      logger.warn('MERCHANT.PARTNER-CONSENT.REVOKED sans merchant_id');
      return;
    }

    const seller = await User.findOne({ paypalMerchantId: merchantId });
    if (!seller) {
      logger.warn('Révocation de consentement pour un vendeur inconnu', {
        merchantId: merchantId.substring(0, 5) + '...'
      });
      return;
    }

    seller.paypalConnected = false;
    seller.paypalOnboarding = {
      ...(seller.paypalOnboarding || {}),
      consentGranted: false,
      checkedAt: new Date()
    };
    await seller.save();

    logger.info('Consentement PayPal révoqué par le vendeur', {
      sellerId: seller._id.toString().substring(0, 5) + '...'
    });

    await NotificationService.createNotification({
      recipientId: seller._id,
      type: 'system',
      title: 'Connexion PayPal révoquée',
      content: 'Vous avez retiré les autorisations PayPal accordées à MyKpopTrade. Vos annonces ne peuvent plus être payées tant que vous n\'avez pas reconnecté votre compte.',
      link: '/settings',
      data: { paypalConnected: false }
    });
  }

  /**
   * Traite les événements de capture refusée
   */
  private static async handleCaptureDenied(event: PayPalWebhookEvent): Promise<void> {
    try {
      const resource = event.resource;
      const orderId = resource.supplementary_data?.related_ids?.order_id ||
        resource.invoice_id ||
        resource.custom_id;

      if (!orderId) {
        logger.warn('Impossible de déterminer l\'orderId dans l\'événement de refus', {
          resourceId: resource.id
        });
        return;
      }

      const payment = await Payment.findOne({ paymentIntentId: orderId });

      if (!payment) {
        logger.warn('Aucun paiement trouvé pour l\'orderId', { orderId });
        return;
      }

      payment.status = 'failed';
      await payment.save();

      // Le produit a été marqué vendu à cet acheteur avant la capture : on
      // annule cette vente, sans toucher à une vente faite à quelqu'un d'autre.
      await Product.updateOne(
        { _id: payment.product, soldTo: payment.buyer },
        { $set: { isAvailable: true, isSold: false }, $unset: { soldAt: 1, soldTo: 1 } }
      );

      dispatchAdminAlert({
        event: 'payment.capture_denied',
        severity: 'critical',
        title: 'Capture de paiement refusée par PayPal',
        summary: `Le paiement de ${payment.amount} ${payment.currency} a échoué, le produit est remis en vente.`,
        adminTab: 'audit',
        fields: [
          { name: 'Montant', value: `${payment.amount} ${payment.currency}`, inline: true },
          { name: 'Order PayPal', value: String(orderId), inline: true }
        ],
        data: { paymentId: payment._id, orderId }
      });
    } catch (error) {
      logger.error('Erreur lors du traitement de l\'événement de capture refusée', { error });
      throw error;
    }
  }
}
