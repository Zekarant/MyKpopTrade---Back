import { Request, Response } from 'express';
import { asyncHandler } from '../../../commons/middlewares/errorMiddleware';
import { PayPalService } from '../services/paypalService';
import User from '../../../models/userModel';
import {
  buildConnectUrl,
  getPayPalConnectionStatus,
  disconnectPayPalForUser,
  initiateDirectPayment,
  captureDirectPayment,
  resolveConfirmPayment,
  fetchPaymentStatus,
  listUserPayments,
  fetchPaymentDetails,
  processRefund
} from '../services/paymentService';
import {
  markShipped,
  confirmDelivery,
  getShipment
} from '../services/shipmentService';
import { HttpError } from '../../../commons/utils/httpError';
import logger from '../../../commons/utils/logger';
import { GdprLogger } from '../../../commons/utils/gdprLogger';

function devErrorDetails(error: unknown) {
  return process.env.NODE_ENV === 'development'
    ? (error instanceof Error ? error.message : String(error))
    : undefined;
}

const USER_ID_LOG_PREFIX_LENGTH = 5;

function truncatedUserId(userId: string): string {
  return userId.substring(0, USER_ID_LOG_PREFIX_LENGTH) + '...';
}

function replyHttpError(
  res: Response,
  error: HttpError,
  options: { withSuccess?: boolean } = {}
) {
  const body: any = {};
  if (options.withSuccess) body.success = false;
  body.message = error.message;
  if (error.code) body.code = error.code;
  return res.status(error.statusCode).json(body);
}

/**
 * Génère l'URL pour connecter un compte vendeur à PayPal
 */
export const generateConnectUrl = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;

  try {
    const connectUrl = await buildConnectUrl(userId);

    logger.info('URL de connexion PayPal générée', { userId: userId });

    return res.status(200).json({
      success: true,
      connectUrl,
      message: 'URL de connexion PayPal générée avec succès'
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return replyHttpError(res, error);
    }
    logger.error('Erreur lors de la génération de l\'URL de connexion PayPal', {
      error: error instanceof Error ? error.message : String(error),
      userId: truncatedUserId(userId)
    });
    return res.status(500).json({
      message: 'Une erreur est survenue lors de la génération de l\'URL de connexion PayPal',
      error: devErrorDetails(error)
    });
  }
});

/**
 * Gère le callback OAuth de PayPal après la connexion d'un compte vendeur
 */
export const handleConnectCallback = asyncHandler(async (req: Request, res: Response) => {
  const { code, state } = req.query;

  if (!code || !state) {
    return res.status(400).redirect(`${process.env.FRONTEND_URL}/account/seller/settings?error=missing_parameters`);
  }

  try {
    const sellerId = state as string;

    const seller = await User.findById(sellerId);
    if (!seller) {
      return res.status(404).redirect(`${process.env.FRONTEND_URL}/account/seller/settings?error=user_not_found`);
    }

    const success = await PayPalService.handleConnectCallback(code as string, sellerId);

    if (success) {
      logger.info('Compte PayPal connecté avec succès', {
        userId: truncatedUserId(sellerId)
      });

      return res.redirect(`${process.env.FRONTEND_URL}/account/seller/settings?paypal_connected=true`);
    } else {
      return res.redirect(`${process.env.FRONTEND_URL}/account/seller/settings?error=connection_failed`);
    }
  } catch (error) {
    const sellerId = state as string;
    logger.error('Erreur lors du callback de connexion PayPal', {
      error: error instanceof Error ? error.message : String(error),
      userId: truncatedUserId(sellerId)
    });
    return res.redirect(`${process.env.FRONTEND_URL}/account/seller/settings?error=server_error`);
  }
});

/**
 * Vérifie l'état de connexion PayPal du vendeur
 */
export const checkPayPalConnection = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;

  try {
    const { connected, expiresAt } = await getPayPalConnectionStatus(userId);

    return res.status(200).json({
      success: true,
      connected,
      expiresAt
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return replyHttpError(res, error);
    }
    logger.error('Erreur lors de la vérification de la connexion PayPal', {
      error: error instanceof Error ? error.message : String(error),
      userId: truncatedUserId(userId)
    });
    return res.status(500).json({
      message: 'Une erreur est survenue lors de la vérification de la connexion PayPal',
      error: devErrorDetails(error)
    });
  }
});

/**
 * Déconnecte le compte PayPal du vendeur
 */
export const disconnectPayPal = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;

  try {
    await disconnectPayPalForUser(userId);

    logger.info('Compte PayPal déconnecté', { userId: truncatedUserId(userId) });

    return res.status(200).json({
      success: true,
      message: 'Compte PayPal déconnecté avec succès'
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return replyHttpError(res, error);
    }
    logger.error('Erreur lors de la déconnexion du compte PayPal', {
      error: error instanceof Error ? error.message : String(error),
      userId: truncatedUserId(userId)
    });
    return res.status(500).json({
      message: 'Une erreur est survenue lors de la déconnexion du compte PayPal',
      error: devErrorDetails(error)
    });
  }
});

/**
 * Initie un paiement PayPal pour un produit
 */
export const initiatePayPalPayment = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const { productId, shippingMethod, shippingAddress } = req.body;

  try {
    const paymentResponse = await initiateDirectPayment(userId, productId, {
      shippingMethod,
      shippingAddress
    });

    return res.status(200).json({
      success: true,
      payment: {
        id: paymentResponse.paymentId,
        paypalOrderId: paymentResponse.orderId,
        amount: paymentResponse.amount,
        productAmount: paymentResponse.productAmount,
        shippingAmount: paymentResponse.shippingAmount,
        shippingMethod: paymentResponse.shippingMethod,
        currency: paymentResponse.currency,
        approvalUrl: paymentResponse.approvalUrl
      },
      message: 'Paiement initié avec succès'
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return replyHttpError(res, error);
    }
    logger.error('Erreur lors de l\'initiation du paiement PayPal', {
      error: error instanceof Error ? error.message : String(error),
      productId,
      userId: truncatedUserId(userId)
    });
    return res.status(500).json({
      message: 'Une erreur est survenue lors de la création du paiement',
      error: devErrorDetails(error)
    });
  }
});

/**
 * Capture un paiement après approbation par l'acheteur
 */
export const capturePayPalPayment = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const { orderId } = req.body;

  try {
    const result = await captureDirectPayment(userId, orderId);

    return res.status(200).json({
      success: true,
      payment: result,
      message: 'Paiement capturé avec succès'
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return replyHttpError(res, error);
    }
    logger.error('Erreur lors de la capture du paiement PayPal', {
      error: error instanceof Error ? error.message : String(error),
      orderId,
      userId: truncatedUserId(userId)
    });
    return res.status(500).json({
      message: 'Une erreur est survenue lors de la capture du paiement',
      error: devErrorDetails(error)
    });
  }
});

/**
 * Confirme un paiement après redirection depuis PayPal
 */
export const confirmPayPalPayment = asyncHandler(async (req: Request, res: Response) => {
  const { orderId } = req.query;
  const frontend = process.env.FRONTEND_URL;

  try {
    const outcome = await resolveConfirmPayment(orderId);

    switch (outcome.kind) {
      case 'missing_order_id':
        return res.redirect(`${frontend}/payment/error?code=missing_order_id`);
      case 'payment_not_found':
        return res.redirect(`${frontend}/payment/error?code=payment_not_found`);
      case 'seller_unavailable':
        return res.redirect(`${frontend}/payment/error?code=seller_unavailable`);
      case 'approved':
        return res.redirect(
          `${frontend}/payment/confirm?orderId=${outcome.orderId}&paymentId=${outcome.paymentId}`
        );
      case 'completed':
        return res.redirect(`${frontend}/payment/success?paymentId=${outcome.paymentId}`);
      case 'other':
        return res.redirect(
          `${frontend}/payment/status?orderId=${outcome.orderId}&status=${outcome.status}`
        );
    }
  } catch (error) {
    logger.error('Erreur lors de la confirmation du paiement', {
      error: error instanceof Error ? error.message : String(error),
      orderId: String(orderId)
    });
    return res.redirect(`${frontend}/payment/error?code=server_error`);
  }
});

/**
 * Gère les webhooks PayPal pour les notifications automatiques de paiement
 * @route POST /api/payments/webhook/paypal
 * @access public - Ne nécessite pas d'authentification (appelé par PayPal)
 */
export const handleWebhook = asyncHandler(async (req: Request, res: Response) => {
  try {
    const event = req.body;

    if (!event || !event.event_type) {
      logger.warn('Webhook PayPal reçu avec un format invalide');
      return res.status(400).json({ message: 'Format de webhook invalide' });
    }

    logger.debug('Webhook PayPal reçu', {
      eventType: event.event_type,
      eventId: event.id,
      resourceType: event.resource_type || 'non spécifié'
    });

    if (process.env.NODE_ENV === 'production') {
      logger.debug('Vérification de la signature du webhook ignorée en développement');
    }

    await PayPalService.handleWebhook(event);

    return res.status(200).json({
      received: true,
      eventType: event.event_type
    });
  } catch (error) {
    logger.error('Erreur lors du traitement du webhook PayPal', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });

    return res.status(200).json({
      received: true,
      processingError: process.env.NODE_ENV === 'development'
        ? (error instanceof Error ? error.message : String(error))
        : 'Une erreur est survenue lors du traitement'
    });
  }
});

/**
 * Vérifie et met à jour le statut d'un paiement
 */
export const checkPaymentStatus = asyncHandler(async (req: Request, res: Response) => {
  const { paymentId } = req.params;
  const userId = (req.user as any).id;

  if (!userId) {
    return res.status(401).json({
      success: false,
      message: 'Authentification requise'
    });
  }

  try {
    const { status, payment } = await fetchPaymentStatus(userId, String(paymentId));

    return res.status(200).json({
      success: true,
      status,
      payment
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return replyHttpError(res, error, { withSuccess: true });
    }
    GdprLogger.logPaymentError(error, userId, { action: 'check_payment_status', paymentId });
    return res.status(500).json({
      success: false,
      message: 'Une erreur est survenue lors de la vérification du statut du paiement'
    });
  }
});

/**
 * Effectue un remboursement total ou partiel pour un paiement
 * @route POST /api/payments/:paymentId/refund
 * @access Private - Vendeur ou admin
 *
 * Initie le remboursement côté PayPal. La mise à jour de l'état du Payment
 * (status, refundAmount, refundedAt) est assurée par le webhook PAYMENT.CAPTURE.REFUNDED.
 */
export const refundPayment = asyncHandler(async (req: Request, res: Response) => {
  const { paymentId } = req.params;
  const { amount, reason } = req.body;
  const userId = (req.user as any).id;

  if (!userId) {
    return res.status(401).json({
      success: false,
      message: 'Authentification requise'
    });
  }

  try {
    const refund = await processRefund({
      userId,
      paymentId: String(paymentId),
      amount,
      reason
    });

    return res.status(200).json({
      success: true,
      message: 'Remboursement initié avec succès',
      refund
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return replyHttpError(res, error, { withSuccess: true });
    }

    GdprLogger.logPaymentError(error, userId, { action: 'refund_payment', paymentId });

    return res.status(500).json({
      success: false,
      message: 'Une erreur est survenue lors du remboursement'
    });
  }
});

/**
 * Récupère la liste des paiements de l'utilisateur
 */
export const getMyPayments = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const { role = 'all', status, page = 1, limit = 10 } = req.query;

  try {
    const pageNum = parseInt(String(page), 10) || 1;
    const limitNum = parseInt(String(limit), 10) || 10;

    const { data, pagination } = await listUserPayments(
      userId,
      role as string,
      status as string | undefined,
      pageNum,
      limitNum
    );

    return res.status(200).json({
      success: true,
      data,
      pagination
    });
  } catch (error) {
    logger.error('Erreur lors de la récupération des paiements', {
      error: error instanceof Error ? error.message : String(error),
      userId: truncatedUserId(userId)
    });
    return res.status(500).json({
      message: 'Une erreur est survenue lors de la récupération des paiements',
      error: devErrorDetails(error)
    });
  }
});

/**
 * Le vendeur enregistre l'expédition (transporteur + numéro de suivi).
 * @route POST /api/payments/:paymentId/shipment
 * @access Private - Vendeur uniquement
 */
export const createShipment = asyncHandler(async (req: Request, res: Response) => {
  const { paymentId } = req.params;
  const userId = (req.user as any).id;
  const { carrier, trackingNumber, trackingUrl } = req.body;

  try {
    const shipment = await markShipped({
      userId,
      paymentId: String(paymentId),
      carrier,
      trackingNumber,
      trackingUrl
    });

    return res.status(201).json({ success: true, shipment });
  } catch (error) {
    if (error instanceof HttpError) {
      return replyHttpError(res, error, { withSuccess: true });
    }
    logger.error('Erreur lors de l\'enregistrement de l\'expédition', {
      error: error instanceof Error ? error.message : String(error),
      paymentId,
      userId: truncatedUserId(userId)
    });
    return res.status(500).json({
      success: false,
      message: 'Une erreur est survenue lors de l\'enregistrement de l\'expédition'
    });
  }
});

/**
 * L'acheteur confirme la réception du colis.
 * @route POST /api/payments/:paymentId/shipment/delivered
 * @access Private - Acheteur uniquement
 */
export const markShipmentDelivered = asyncHandler(async (req: Request, res: Response) => {
  const { paymentId } = req.params;
  const userId = (req.user as any).id;

  try {
    const shipment = await confirmDelivery(userId, String(paymentId));
    return res.status(200).json({ success: true, shipment });
  } catch (error) {
    if (error instanceof HttpError) {
      return replyHttpError(res, error, { withSuccess: true });
    }
    logger.error('Erreur lors de la confirmation de réception', {
      error: error instanceof Error ? error.message : String(error),
      paymentId,
      userId: truncatedUserId(userId)
    });
    return res.status(500).json({
      success: false,
      message: 'Une erreur est survenue lors de la confirmation de réception'
    });
  }
});

/**
 * Récupère les infos de suivi d'un paiement.
 * @route GET /api/payments/:paymentId/shipment
 * @access Private - Acheteur ou vendeur du paiement
 */
export const fetchShipment = asyncHandler(async (req: Request, res: Response) => {
  const { paymentId } = req.params;
  const userId = (req.user as any).id;

  try {
    const shipment = await getShipment(userId, String(paymentId));
    return res.status(200).json({ success: true, shipment });
  } catch (error) {
    if (error instanceof HttpError) {
      return replyHttpError(res, error, { withSuccess: true });
    }
    logger.error('Erreur lors de la récupération de l\'expédition', {
      error: error instanceof Error ? error.message : String(error),
      paymentId,
      userId: truncatedUserId(userId)
    });
    return res.status(500).json({
      success: false,
      message: 'Une erreur est survenue lors de la récupération de l\'expédition'
    });
  }
});

/**
 * Récupère les détails d'un paiement spécifique
 * @route GET /api/payments/:paymentId
 * @access Private - Limité à l'acheteur, au vendeur et aux administrateurs
 */
export const getPayment = asyncHandler(async (req: Request, res: Response) => {
  const { paymentId } = req.params;
  const userId = (req.user as any).id;

  if (!userId) {
    return res.status(401).json({
      success: false,
      message: 'Authentification requise'
    });
  }

  try {
    const payment = await fetchPaymentDetails(userId, String(paymentId));

    return res.status(200).json({
      success: true,
      payment
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return replyHttpError(res, error, { withSuccess: true });
    }
    GdprLogger.logPaymentError(error, userId, { action: 'get_payment_details', paymentId });
    return res.status(500).json({
      success: false,
      message: 'Une erreur est survenue lors de la récupération du paiement'
    });
  }
});
