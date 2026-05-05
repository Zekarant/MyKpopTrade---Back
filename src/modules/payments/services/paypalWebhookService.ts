import Payment from '../../../models/paymentModel';
import Product from '../../../models/productModel';
import Conversation from '../../../models/conversationModel';
import Message from '../../../models/messageModel';
import { NotificationService } from '../../notifications/services/notificationService';
import logger from '../../../commons/utils/logger';
import { add, gt } from '../../../commons/utils/moneyMath';

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
        case 'CHECKOUT.ORDER.APPROVED':
        case 'PAYMENT.CAPTURE.COMPLETED':
          await PayPalWebhookService.handlePaymentCompleted(event);
          break;

        case 'PAYMENT.CAPTURE.REFUNDED':
          await PayPalWebhookService.handleRefund(event);
          break;

        case 'PAYMENT.CAPTURE.DENIED':
          await PayPalWebhookService.handleCaptureDenied(event);
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
   * Traite les événements de paiement/capture complété
   */
  private static async handlePaymentCompleted(event: any): Promise<void> {
    try {
      const resource = event.resource;
      const orderId = resource.id ||
        resource.supplementary_data?.related_ids?.order_id ||
        resource.invoice_id ||
        resource.custom_id;

      if (!orderId) {
        logger.warn('Impossible de déterminer l\'orderId dans l\'événement de capture', {
          resourceId: resource.id
        });
        return;
      }

      const payment = await Payment.findOne({ paymentIntentId: orderId });

      if (!payment) {
        logger.warn('Aucun paiement trouvé pour l\'orderId', { orderId });
        return;
      }

      if (payment.status !== 'completed') {
        payment.status = 'completed';
        payment.completedAt = new Date();

        if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED' && resource.id) {
          payment.captureId = resource.id;
        }

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

      payment.refunds = payment.refunds || [];
      const existing = payment.refunds.find((r: any) => r.refundId === refundId);

      if (existing && existing.status === 'completed') {
        logger.debug('Webhook de remboursement déjà traité, ignoré', { refundId });
        return;
      }

      if (existing) {
        existing.status = 'completed';
        existing.settledAt = new Date();
      } else {
        payment.refunds.push({
          refundId,
          amount: refundAmount,
          currency: refundCurrency,
          status: 'completed',
          initiatedAt: new Date(),
          settledAt: new Date()
        });
      }

      // Recalcul à partir de l'historique « completed » uniquement.
      const totalRefunded = payment.refunds
        .filter((r: any) => r.status === 'completed')
        .reduce((sum: number, r: any) => add(sum, r.amount), 0);

      const isFullyRefunded = !gt(payment.amount, totalRefunded);

      payment.totalRefunded = totalRefunded;
      payment.status = isFullyRefunded ? 'refunded' : 'partially_refunded';
      payment.refundAmount = totalRefunded; // legacy (back-compat)
      payment.refundId = refundId;
      payment.refundedAt = new Date();

      await payment.save();

      if (isFullyRefunded) {
        await Product.findByIdAndUpdate(payment.product, {
          isAvailable: true,
          isSold: false,
          soldAt: null,
          soldTo: null
        });
      }

      await NotificationService.createNotification({
        recipientId: payment.buyer,
        type: 'system',
        title: isFullyRefunded ? 'Remboursement complet reçu' : 'Remboursement partiel reçu',
        content: `Vous avez été remboursé de ${refundAmount} ${refundCurrency} pour votre achat.`,
        link: `/account/purchases/${payment._id}`,
        data: {
          paymentId: payment._id,
          productId: payment.product,
          refundAmount,
          totalRefunded,
          currency: refundCurrency,
          isRefund: true
        }
      });

      // Notifier aussi le vendeur (information comptable)
      await NotificationService.createNotification({
        recipientId: payment.seller,
        type: 'system',
        title: isFullyRefunded ? 'Remboursement complet effectué' : 'Remboursement partiel effectué',
        content: `Un remboursement de ${refundAmount} ${refundCurrency} a été émis depuis votre compte.`,
        link: `/account/sales/${payment._id}`,
        data: {
          paymentId: payment._id,
          refundAmount,
          totalRefunded,
          currency: refundCurrency,
          isRefund: true
        }
      });
    } catch (error) {
      logger.error('Erreur lors du traitement de l\'événement de remboursement', { error });
      throw error;
    }
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
