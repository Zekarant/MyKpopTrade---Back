import type Stripe from 'stripe';
import Payment from '../../../models/paymentModel';
import Product from '../../../models/productModel';
import User from '../../../models/userModel';
import Conversation from '../../../models/conversationModel';
import Message from '../../../models/messageModel';
import { NotificationService } from '../../notifications/services/notificationService';
import logger from '../../../commons/utils/logger';
import { add, gt } from '../../../commons/utils/moneyMath';
import { fromCents, getStripe } from './stripeClient';

/**
 * Vérifie la signature HMAC du webhook Stripe et reconstruit l'event.
 * Doit être appelé sur le **body brut** (Buffer) — d'où le montage en
 * `express.raw()` côté app.ts.
 */
export function verifyStripeWebhook(
  rawBody: Buffer,
  signature: string | undefined
): Stripe.Event {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error('STRIPE_WEBHOOK_SECRET non configuré');
  }
  if (!signature) {
    throw new Error('Signature Stripe manquante');
  }
  const stripe = getStripe();
  return stripe.webhooks.constructEvent(rawBody, signature, secret);
}

export async function handleStripeWebhook(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed':
      await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
      break;
    case 'charge.refunded':
      await handleChargeRefunded(event.data.object as Stripe.Charge);
      break;
    case 'payment_intent.payment_failed':
      await handlePaymentFailed(event.data.object as Stripe.PaymentIntent);
      break;
    case 'account.updated':
      await handleAccountUpdated(event.data.object as Stripe.Account);
      break;
    case 'payout.failed':
      logger.warn('Stripe payout failed', {
        payoutId: (event.data.object as any).id,
        failure: (event.data.object as any).failure_message
      });
      break;
    default:
      logger.debug('Webhook Stripe non traité', { type: event.type });
  }
}

async function handleCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
  const payment = await Payment.findOne({ stripeCheckoutSessionId: session.id });
  if (!payment) {
    logger.warn('Paiement Stripe introuvable pour session', { sessionId: session.id });
    return;
  }

  if (payment.status === 'completed') return;

  payment.status = 'completed';
  payment.completedAt = new Date();
  if (typeof session.payment_intent === 'string') {
    payment.stripePaymentIntentId = session.payment_intent;
  }

  // Récupérer la charge associée pour stocker stripeChargeId (utile pour les refunds par charge)
  if (typeof session.payment_intent === 'string') {
    try {
      const stripe = getStripe();
      const pi = await stripe.paymentIntents.retrieve(session.payment_intent, {
        expand: ['latest_charge']
      });
      const charge = (pi.latest_charge as Stripe.Charge | null) || null;
      if (charge?.id) {
        payment.stripeChargeId = charge.id;
        payment.captureId = charge.id;
      }
    } catch (err: any) {
      logger.warn('Impossible de récupérer le PaymentIntent pour stocker la charge', {
        paymentIntentId: session.payment_intent,
        error: err.message
      });
    }
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
  }
}

async function handleChargeRefunded(charge: Stripe.Charge): Promise<void> {
  const payment = await Payment.findOne({
    $or: [
      { stripeChargeId: charge.id },
      { stripePaymentIntentId: typeof charge.payment_intent === 'string' ? charge.payment_intent : '' }
    ]
  });

  if (!payment) {
    logger.warn('Paiement Stripe introuvable pour charge.refunded', { chargeId: charge.id });
    return;
  }

  // Stripe peut envoyer plusieurs refund_objects sur une même charge
  // (refunds successifs). On synchronise les refunds renvoyés par l'event.
  const refundsList = (charge as any).refunds?.data ?? [];
  payment.refunds = payment.refunds || [];

  for (const refund of refundsList) {
    const existing = payment.refunds.find((r: any) => r.refundId === refund.id);
    if (existing) {
      if (refund.status === 'succeeded' && existing.status !== 'completed') {
        existing.status = 'completed';
        existing.settledAt = new Date();
      }
    } else {
      payment.refunds.push({
        refundId: refund.id,
        amount: fromCents(refund.amount),
        currency: (refund.currency || payment.currency).toUpperCase(),
        status: refund.status === 'succeeded' ? 'completed' : 'pending',
        initiatedAt: new Date(refund.created * 1000),
        settledAt: refund.status === 'succeeded' ? new Date() : undefined
      });
    }
  }

  const totalRefunded = payment.refunds
    .filter((r: any) => r.status === 'completed')
    .reduce((sum: number, r: any) => add(sum, r.amount), 0);

  const isFullyRefunded = !gt(payment.amount, totalRefunded);
  payment.totalRefunded = totalRefunded;
  payment.status = isFullyRefunded ? 'refunded' : 'partially_refunded';
  payment.refundAmount = totalRefunded;
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
    content: `Vous avez été remboursé de ${fromCents(charge.amount_refunded)} ${(charge.currency || '').toUpperCase()} pour votre achat.`,
    link: `/account/purchases/${payment._id}`,
    data: {
      paymentId: payment._id,
      totalRefunded,
      currency: payment.currency,
      isRefund: true
    }
  });

  await NotificationService.createNotification({
    recipientId: payment.seller,
    type: 'system',
    title: isFullyRefunded ? 'Remboursement complet effectué' : 'Remboursement partiel effectué',
    content: `Un remboursement a été émis (${totalRefunded} ${payment.currency}).`,
    link: `/account/sales/${payment._id}`,
    data: {
      paymentId: payment._id,
      totalRefunded,
      currency: payment.currency,
      isRefund: true
    }
  });
}

async function handlePaymentFailed(pi: Stripe.PaymentIntent): Promise<void> {
  const payment = await Payment.findOne({ stripePaymentIntentId: pi.id });
  if (!payment) return;

  payment.status = 'failed';
  await payment.save();

  await Product.findByIdAndUpdate(payment.product, {
    isAvailable: true,
    isReserved: false,
    reservedFor: null
  });
}

async function handleAccountUpdated(account: Stripe.Account): Promise<void> {
  const user = await User.findOne({ stripeAccountId: account.id });
  if (!user) return;

  const payoutsEnabled = Boolean(account.payouts_enabled);
  const chargesEnabled = Boolean(account.charges_enabled);

  user.stripePayoutsEnabled = payoutsEnabled;
  user.stripeChargesEnabled = chargesEnabled;
  await user.save();

  logger.info('Compte Stripe vendeur mis à jour via webhook', {
    userId: String(user._id),
    payoutsEnabled,
    chargesEnabled
  });
}
