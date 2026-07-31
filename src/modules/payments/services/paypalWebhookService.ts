import Payment from '../../../models/paymentModel';
import Product from '../../../models/productModel';
import Conversation from '../../../models/conversationModel';
import Message from '../../../models/messageModel';
import User from '../../../models/userModel';
import { PayPalPartnerService } from './paypalPartnerService';
import { applyRefundToPayment, notifyRefund } from './refundLedger';
import { NotificationService } from '../../notifications/services/notificationService';
import logger from '../../../commons/utils/logger';

/**
 * Dispatcher + handlers des webhooks PayPal.
 * Chaque handler met à jour l'état métier (paiement, produit, conversation, notif).
 */
export class PayPalWebhookService {
  /**
   * Traite le webhook PayPal pour gérer les événements de paiement
   */
  static async handleWebhook(event: any): Promise<void> {
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
  private static async handlePaymentCompleted(event: any): Promise<void> {
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

      // Le captureId est enregistré même si le paiement est déjà « completed »
      // (capture faite en synchrone par l'API puis webhook redélivré) : sans
      // lui, le vendeur ne peut plus rembourser.
      if (captureId && payment.captureId !== captureId) {
        payment.captureId = captureId;
        await payment.save();
      }

      if (payment.status !== 'completed') {
        payment.status = 'completed';
        payment.completedAt = new Date();

        await payment.save();

        await Product.findByIdAndUpdate(payment.product, {
          isAvailable: false,
          isSold: true,
          soldAt: new Date(),
          soldTo: payment.buyer
        });

        await NotificationService.createNotification({
          recipientId: payment.seller,
          type: 'system',
          title: 'Nouveau paiement reçu',
          content: `Un acheteur a payé ${payment.amount} ${payment.currency} pour votre produit.`,
          link: `/account/sales/${payment._id}`,
          data: {
            paymentId: payment._id,
            productId: payment.product,
            amount: payment.amount,
            currency: payment.currency
          }
        });

        const conversation = await Conversation.findOne({
          productId: payment.product,
          participants: { $all: [payment.buyer, payment.seller] },
          isActive: true
        });

        if (conversation) {
          await Message.create({
            conversation: conversation._id,
            sender: payment.seller,
            content: 'Paiement validé ☑️ — nous vous laissons organiser l\'envoi du colis avec le vendeur.',
            contentType: 'system_notification',
            isSystemMessage: true,
            readBy: []
          });

          await Conversation.updateOne(
            { _id: conversation._id },
            { lastMessageAt: new Date() }
          );
        } else {
          logger.warn('Aucune conversation trouvée pour poster le message de paiement validé', {
            paymentId: payment._id,
            productId: payment.product
          });
        }
      }
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
  private static async handleRefund(event: any): Promise<void> {
    try {
      const resource = event.resource;
      const captureId = resource.links.find((link: any) => link.rel === 'up')?.href.split('/').pop();

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

      const refundAmount = parseFloat(resource.amount.value);
      const refundCurrency = resource.amount.currency_code;
      const refundId = resource.id;

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
  private static async handleOnboardingCompleted(event: any): Promise<void> {
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
      (seller._id as any).toString(),
      merchantId
    );

    if (status && PayPalPartnerService.isReady(status)) {
      await NotificationService.createNotification({
        recipientId: seller._id as any,
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
  private static async handleMerchantIntegrationUpdated(event: any): Promise<void> {
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
      (seller._id as any).toString()
    );

    logger.info('Statut vendeur resynchronisé après mise à jour PayPal', {
      sellerId: (seller._id as any).toString().substring(0, 5) + '...',
      eventType: event.event_type,
      ready: status ? PayPalPartnerService.isReady(status) : false
    });
  }

  /**
   * Le vendeur a révoqué les permissions accordées à MyKpopTrade depuis son
   * espace PayPal. Plus aucune capture ni remboursement n'est possible en son
   * nom : on coupe immédiatement PayPal pour ce vendeur.
   */
  private static async handleConsentRevoked(event: any): Promise<void> {
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
      sellerId: (seller._id as any).toString().substring(0, 5) + '...'
    });

    await NotificationService.createNotification({
      recipientId: seller._id as any,
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
  private static async handleCaptureDenied(event: any): Promise<void> {
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

      await Product.findByIdAndUpdate(payment.product, {
        isAvailable: true,
        isReserved: false,
        reservedFor: null
      });
    } catch (error) {
      logger.error('Erreur lors du traitement de l\'événement de capture refusée', { error });
      throw error;
    }
  }
}
