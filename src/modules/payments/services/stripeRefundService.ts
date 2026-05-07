import Payment from '../../../models/paymentModel';
import User from '../../../models/userModel';
import { HttpError } from '../../../commons/utils/httpError';
import { GdprLogger } from '../../../commons/utils/gdprLogger';
import logger from '../../../commons/utils/logger';
import { recordAuditLog } from '../../../commons/utils/auditService';
import { gt, subtract } from '../../../commons/utils/moneyMath';
import { getStripe, toCents } from './stripeClient';

const USER_ID_LOG_PREFIX_LENGTH = 5;

async function isUserAdmin(userId: string): Promise<boolean> {
  const user = await User.findById(userId).select('role');
  return Boolean(user && user.role === 'admin');
}

/**
 * Rembourse (total ou partiel) un paiement Stripe.
 *
 * Stripe gère nativement le split : on rembourse le PaymentIntent, et l'argent
 * revient depuis le compte vendeur (et la commission depuis le compte plateforme
 * grâce à `reverse_transfer: true` + `refund_application_fee: true`).
 *
 * `processRefund` du module PayPal n'a pas à être touché — ce service est
 * appelé en parallèle par `paymentService.processRefund` selon `paymentMethod`.
 */
export async function refundStripePayment({
  userId,
  paymentId,
  amount,
  reason,
  password
}: {
  userId: string;
  paymentId: string;
  amount?: unknown;
  reason?: string;
  password?: string;
}) {
  const payment = await Payment.findById(paymentId);
  if (!payment) {
    throw new HttpError(404, 'Paiement non trouvé');
  }

  if (payment.paymentMethod !== 'stripe') {
    throw new HttpError(400, 'Ce paiement n\'est pas un paiement Stripe');
  }

  const isSeller = payment.seller.toString() === userId;
  const isAdmin = await isUserAdmin(userId);
  if (!isSeller && !isAdmin) {
    GdprLogger.logPaymentAction('unauthorized_refund_attempt', {
      paymentId,
      targetPaymentSeller: payment.seller.toString()
    }, userId);
    throw new HttpError(403, 'Seul le vendeur ou un administrateur peut effectuer un remboursement');
  }

  if (payment.status !== 'completed' && payment.status !== 'partially_refunded') {
    throw new HttpError(400, 'Seul un paiement complété (ou partiellement remboursé) peut être remboursé');
  }

  if (!payment.stripePaymentIntentId) {
    throw new HttpError(400, 'Aucun PaymentIntent Stripe associé à ce paiement');
  }

  if (!isAdmin) {
    if (!password) {
      throw new HttpError(400, 'Mot de passe de confirmation requis');
    }
    const userWithPwd = await User.findById(userId).select('+password');
    if (!userWithPwd || !(await userWithPwd.comparePassword(password))) {
      GdprLogger.logPaymentAction('refund_password_invalid', { paymentId }, userId);
      throw new HttpError(401, 'Mot de passe incorrect');
    }
  }

  const alreadyRefunded = payment.totalRefunded || 0;
  const remaining = subtract(payment.amount, alreadyRefunded);

  if (gt(0.01, remaining)) {
    throw new HttpError(400, 'Ce paiement a déjà été entièrement remboursé');
  }

  let refundAmount: number | null;
  if (amount === undefined || amount === null || amount === '') {
    refundAmount = null;
  } else {
    const parsed = typeof amount === 'number' ? amount : parseFloat(String(amount));
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new HttpError(400, 'Le montant du remboursement doit être un nombre strictement positif');
    }
    if (gt(parsed, remaining)) {
      throw new HttpError(
        400,
        `Le montant demandé (${parsed} ${payment.currency}) dépasse le restant remboursable (${remaining} ${payment.currency})`
      );
    }
    refundAmount = parsed;
  }

  const stripe = getStripe();

  try {
    const refundParams: any = {
      payment_intent: payment.stripePaymentIntentId,
      reason: 'requested_by_customer',
      reverse_transfer: true,
      refund_application_fee: true,
      metadata: {
        payment_id: String(payment._id),
        initiated_by: userId,
        custom_reason: (reason || '').slice(0, 250)
      }
    };

    if (refundAmount !== null) {
      refundParams.amount = toCents(refundAmount);
    }

    const refund = await stripe.refunds.create(refundParams);

    payment.refunds = payment.refunds || [];
    payment.refunds.push({
      refundId: refund.id,
      amount: refundAmount !== null ? refundAmount : remaining,
      currency: payment.currency,
      reason: reason || undefined,
      status: refund.status === 'succeeded' ? 'completed' : 'pending',
      initiatedBy: new (require('mongoose').Types.ObjectId)(userId),
      initiatedAt: new Date()
    });
    await payment.save();

    GdprLogger.logPaymentAction('refund_initiated', {
      paymentId,
      refundId: refund.id,
      method: 'stripe',
      isPartial: refundAmount !== null,
      amount: refundAmount
    }, userId);

    if (isAdmin) {
      await recordAuditLog({
        adminId: userId,
        action: refundAmount === null ? 'refund_full' : 'refund_partial',
        targetType: 'payment',
        targetId: payment._id as any,
        details: reason || undefined,
        metadata: {
          refundId: refund.id,
          method: 'stripe',
          amount: refundAmount,
          currency: payment.currency
        }
      });
    }

    return {
      refundId: refund.id,
      status: refund.status,
      amount: refundAmount !== null ? refundAmount : remaining,
      currency: payment.currency,
      remaining: subtract(remaining, refundAmount !== null ? refundAmount : remaining),
      createdAt: new Date(refund.created * 1000)
    };
  } catch (err: any) {
    logger.error('Erreur lors du remboursement Stripe', {
      paymentId,
      userId: userId.substring(0, USER_ID_LOG_PREFIX_LENGTH) + '...',
      error: err.message,
      stripeCode: err.code,
      stripeType: err.type
    });
    throw new HttpError(400, err.message || 'Erreur lors du remboursement Stripe');
  }
}
