import { Request, Response } from 'express';
import { asyncHandler } from '../../../commons/middlewares/errorMiddleware';
import { HttpError } from '../../../commons/utils/httpError';
import logger from '../../../commons/utils/logger';
import {
  createSellerAccount,
  createAccountSession,
  getSellerStatus
} from '../services/stripeConnectService';
import { createStripeCheckoutSession } from '../services/stripeCheckoutService';
import { refundStripePayment } from '../services/stripeRefundService';
import {
  verifyStripeWebhook,
  handleStripeWebhook
} from '../services/stripeWebhookService';

function devErrorDetails(error: unknown) {
  return process.env.NODE_ENV === 'development'
    ? (error instanceof Error ? error.message : String(error))
    : undefined;
}

function replyHttpError(res: Response, error: HttpError) {
  const body: any = { success: false, message: error.message };
  if (error.code) body.code = error.code;
  return res.status(error.statusCode).json(body);
}

/**
 * Crée le compte Stripe Connect du vendeur sans passer par l'interface Stripe.
 * Le compte existe immédiatement ; payouts_enabled reste false jusqu'au KYC.
 * @route POST /api/payments/stripe/create-account
 */
export const createStripeAccount = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  try {
    const { accountId, alreadyExisted } = await createSellerAccount(userId);
    return res.status(alreadyExisted ? 200 : 201).json({
      success: true,
      accountId,
      alreadyExisted,
      message: alreadyExisted ? 'Compte Stripe déjà existant' : 'Compte Stripe créé avec succès'
    });
  } catch (error) {
    if (error instanceof HttpError) return replyHttpError(res, error);
    logger.error('Erreur création compte Stripe', {
      userId,
      error: error instanceof Error ? error.message : String(error)
    });
    return res.status(500).json({
      success: false,
      message: 'Une erreur est survenue lors de la création du compte Stripe',
      error: devErrorDetails(error)
    });
  }
});

/**
 * Crée une Account Session pour l'embedded onboarding Stripe Connect.
 * Retourne un client_secret à passer à @stripe/connect-js côté frontend.
 * @route POST /api/payments/stripe/account-session
 */
export const createStripeAccountSession = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  try {
    const { clientSecret, accountId } = await createAccountSession(userId);
    return res.status(200).json({ success: true, clientSecret, accountId });
  } catch (error) {
    if (error instanceof HttpError) return replyHttpError(res, error);
    logger.error('Erreur création account session Stripe', {
      userId,
      error: error instanceof Error ? error.message : String(error)
    });
    return res.status(500).json({
      success: false,
      message: 'Une erreur est survenue lors de la création de la session Stripe',
      error: devErrorDetails(error)
    });
  }
});

/**
 * Récupère l'état Stripe Connect du vendeur courant (KYC, capabilities).
 * @route GET /api/payments/stripe/account-status
 */
export const checkStripeAccountStatus = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  try {
    const status = await getSellerStatus(userId);
    return res.status(200).json({ success: true, ...status });
  } catch (error) {
    if (error instanceof HttpError) return replyHttpError(res, error);
    logger.error('Erreur status Stripe', {
      userId,
      error: error instanceof Error ? error.message : String(error)
    });
    return res.status(500).json({
      success: false,
      message: 'Une erreur est survenue lors de la récupération du statut Stripe',
      error: devErrorDetails(error)
    });
  }
});

/**
 * Crée une Checkout Session Stripe pour acheter un produit.
 * @route POST /api/payments/stripe/checkout
 */
export const initiateStripeCheckout = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const { productId, shippingMethod, shippingAddress } = req.body;

  try {
    const result = await createStripeCheckoutSession({
      productId,
      buyerId: userId,
      shippingMethod,
      shippingAddress
    });

    return res.status(200).json({
      success: true,
      payment: {
        id: result.paymentId,
        stripeSessionId: result.sessionId,
        checkoutUrl: result.checkoutUrl,
        amount: result.amount,
        productAmount: result.productAmount,
        shippingAmount: result.shippingAmount,
        shippingMethod: result.shippingMethod,
        currency: result.currency
      },
      message: 'Checkout Stripe initié avec succès'
    });
  } catch (error) {
    if (error instanceof HttpError) return replyHttpError(res, error);
    logger.error('Erreur initiation Stripe Checkout', {
      productId,
      userId,
      error: error instanceof Error ? error.message : String(error)
    });
    return res.status(500).json({
      success: false,
      message: 'Une erreur est survenue lors de la création du paiement Stripe',
      error: devErrorDetails(error)
    });
  }
});

/**
 * Effectue un remboursement Stripe (total ou partiel).
 * @route POST /api/payments/stripe/:paymentId/refund
 */
export const refundStripePaymentEndpoint = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const { paymentId } = req.params;
  const { amount, reason, password } = req.body;

  try {
    const refund = await refundStripePayment({
      userId,
      paymentId: String(paymentId),
      amount,
      reason,
      password
    });
    return res.status(200).json({ success: true, refund, message: 'Remboursement Stripe initié' });
  } catch (error) {
    if (error instanceof HttpError) return replyHttpError(res, error);
    logger.error('Erreur refund Stripe', {
      paymentId,
      userId,
      error: error instanceof Error ? error.message : String(error)
    });
    return res.status(500).json({
      success: false,
      message: 'Une erreur est survenue lors du remboursement Stripe',
      error: devErrorDetails(error)
    });
  }
});

/**
 * Webhook Stripe — reçoit les événements et les traite.
 * **Doit recevoir le body brut** (Buffer) pour vérifier la signature HMAC.
 * Monté en `express.raw()` AVANT `express.json()` dans app.ts.
 * @route POST /api/payments/stripe/webhook
 */
export const handleStripeWebhookEndpoint = async (req: Request, res: Response) => {
  const signature = req.headers['stripe-signature'] as string | undefined;

  let event;
  try {
    event = verifyStripeWebhook(req.body as Buffer, signature);
  } catch (err: any) {
    logger.warn('Signature webhook Stripe invalide', { error: err.message });
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    await handleStripeWebhook(event);
    return res.status(200).json({ received: true, type: event.type });
  } catch (err: any) {
    logger.error('Erreur traitement webhook Stripe', {
      type: event.type,
      error: err.message,
      stack: err.stack
    });
    // On renvoie 200 quand même : Stripe re-livrera, ça évite d'inonder les retries
    // pour des erreurs de logique métier déjà loguées et investigables.
    return res.status(200).json({ received: true, processingError: true });
  }
};
