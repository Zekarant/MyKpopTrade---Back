import mongoose from 'mongoose';
import Payment, { IPayment } from '../../../models/paymentModel';
import Product from '../../../models/productModel';
import Conversation from '../../../models/conversationModel';
import Message from '../../../models/messageModel';
import { NotificationService } from '../../notifications/services/notificationService';
import { dispatchAdminAlert } from '../../../commons/services/adminAlertService';
import logger from '../../../commons/utils/logger';

/**
 * Statuts atteints après l'encaissement. Un webhook de capture redélivré après
 * un remboursement ne doit pas faire repasser le paiement à « completed ».
 */
const ALREADY_SETTLED_STATUSES: IPayment['status'][] = ['completed', 'refunded', 'partially_refunded'];

/**
 * - `completed` : cet appel a fait passer le paiement à « completed ».
 * - `already_completed` : un autre appel (capture, webhook, confirmation) l'a
 *   déjà fait ; rien n'a été rejoué.
 * - `product_conflict` : l'argent est encaissé mais le produit a été vendu à
 *   quelqu'un d'autre entre-temps ; un admin doit rembourser.
 */
export type PaymentCompletionOutcome = 'completed' | 'already_completed' | 'product_conflict';

/**
 * Seul point d'écriture de la finalisation d'un paiement encaissé, partagé par
 * la capture synchrone, le webhook PAYMENT.CAPTURE.COMPLETED et la confirmation
 * au retour de PayPal. Ces trois chemins peuvent s'exécuter en parallèle sur le
 * même paiement : la transition conditionnelle garantit qu'un seul d'entre eux
 * vend le produit et prévient le vendeur. Pas de transaction multi-documents
 * (la base de production peut être un serveur standalone) : chaque écriture est
 * une mise à jour atomique conditionnelle.
 */
export async function completePayment(
  paymentId: mongoose.Types.ObjectId,
  captureId?: string
): Promise<PaymentCompletionOutcome> {
  const payment = await Payment.findOneAndUpdate(
    { _id: paymentId, status: { $nin: ALREADY_SETTLED_STATUSES } },
    { $set: { status: 'completed', completedAt: new Date(), ...(captureId && { captureId }) } },
    { returnDocument: 'after' }
  );

  if (!payment) {
    // Le captureId est rattrapé même si le paiement était déjà finalisé
    // (capture synchrone sans réponse exploitable, puis webhook) : sans lui,
    // le vendeur ne peut plus rembourser.
    if (captureId) {
      await Payment.updateOne({ _id: paymentId, captureId: { $ne: captureId } }, { $set: { captureId } });
    }
    return 'already_completed';
  }

  if (!(await markProductSold(payment))) {
    alertProductAlreadySold(payment);
    return 'product_conflict';
  }

  await announceCompletedPayment(payment);
  return 'completed';
}

/**
 * Vend le produit à l'acheteur, sauf s'il est déjà vendu. La capture le
 * réserve à l'acheteur avant d'encaisser : le trouver déjà vendu à CET
 * acheteur n'est donc pas un conflit.
 */
async function markProductSold(payment: IPayment): Promise<boolean> {
  const { matchedCount } = await Product.updateOne(
    { _id: payment.product, isSold: false },
    { $set: { isAvailable: false, isSold: true, soldAt: new Date(), soldTo: payment.buyer } }
  );
  if (matchedCount === 1) return true;

  return Boolean(await Product.exists({ _id: payment.product, soldTo: payment.buyer }));
}

/**
 * Même règle que la capture, qui refuse d'encaisser un produit déjà vendu :
 * ici l'argent a déjà bougé (capture perdue puis webhook, typiquement), donc on
 * ne vend pas le produit une seconde fois et on demande un remboursement.
 */
function alertProductAlreadySold(payment: IPayment): void {
  logger.error('Paiement encaissé pour un produit déjà vendu à un autre acheteur', {
    paymentId: payment._id,
    productId: payment.product
  });

  dispatchAdminAlert({
    event: 'payment.product_already_sold',
    severity: 'critical',
    title: 'Paiement encaissé pour un produit déjà vendu',
    summary: `${payment.amount} ${payment.currency} ont été encaissés pour un produit vendu à un autre acheteur : remboursez ce paiement.`,
    adminTab: 'audit',
    fields: [
      { name: 'Montant', value: `${payment.amount} ${payment.currency}`, inline: true },
      { name: 'Paiement', value: String(payment._id), inline: true }
    ],
    data: { paymentId: payment._id, productId: payment.product }
  });
}

/** Prévient le vendeur et poste le message système dans la conversation de la vente. */
async function announceCompletedPayment(payment: IPayment): Promise<void> {
  await NotificationService.createNotification({
    recipientId: payment.seller,
    type: 'system',
    title: 'Nouveau paiement reçu',
    content: `Votre produit a été acheté pour ${payment.amount} ${payment.currency}.`,
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

  if (!conversation) {
    logger.warn('Aucune conversation trouvée pour poster le message de paiement validé', {
      paymentId: payment._id,
      productId: payment.product
    });
    return;
  }

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
}
