import { Request, Response } from 'express';
import {
  buildOnboardingLink,
  getPayPalAccountStatus,
  disconnectPayPalForUser,
  completeOnboardingReturn,
  initiateDirectPayment,
  captureDirectPayment,
  cancelDirectPayment,
  resolveConfirmPayment,
  fetchPaymentStatus,
  listUserPayments,
  processRefund
} from '../services/paymentService';
import {
  markShipped,
  confirmDelivery,
  getShipment
} from '../services/shipmentService';
import { PayPalService } from '../services/paypalService';
import { isAuthenticWebhook } from '../services/paypalWebhookService';
import { badRequest, HttpError } from '../../../commons/utils/httpError';
import logger from '../../../commons/utils/logger';
import env from '../../../config/env';
import { parsePagination } from '../../../commons/utils/pagination';
import { queryString } from '../../../commons/utils/query';

const MY_PAYMENTS_DEFAULT_LIMIT = 10;

/**
 * Génère le lien d'inscription PayPal (Partner Referrals) d'un vendeur.
 */
export const generateOnboardingLink = async (req: Request, res: Response) => {
  const actionUrl = await buildOnboardingLink(req.user!.id);

  res.status(200).json({
    success: true,
    actionUrl,
    message: 'Lien d\'inscription PayPal généré avec succès'
  });
};

/**
 * Retour du vendeur après le parcours d'onboarding PayPal.
 *
 * PayPal renvoie `merchantIdInPayPal` en query param. Cette valeur transite par
 * le navigateur du vendeur : elle sert uniquement à savoir quel compte
 * interroger. Le statut réel est ensuite confirmé par « show seller status ».
 * Le rapprochement avec le vendeur MyKpopTrade se fait sur le `tracking_id`,
 * jamais sur un identifiant fourni par le client.
 */
export const handleOnboardingReturn = async (req: Request, res: Response) => {
  const frontendSettings = `${env.FRONTEND_URL}/settings`;
  const { merchantIdInPayPal, merchantId: trackingId } = req.query;

  // Chaînes uniquement : un paramètre répété devient un tableau, que Mongoose
  // traduit en `$in` (des centaines d'essais de tracking_id en une requête).
  if (typeof merchantIdInPayPal !== 'string' || typeof trackingId !== 'string' ||
      !merchantIdInPayPal || !trackingId) {
    return res.redirect(`${frontendSettings}?paypal_error=missing_parameters`);
  }

  // Le vendeur arrive ici par une redirection de navigateur : une erreur doit le
  // ramener sur ses paramètres avec `paypal_error`, pas lui afficher du JSON.
  try {
    const outcome = await completeOnboardingReturn(merchantIdInPayPal, trackingId);
    if (outcome === 'unknown_tracking_id') {
      return res.redirect(`${frontendSettings}?paypal_error=unknown_tracking_id`);
    }
    return res.redirect(`${frontendSettings}?paypal_onboarding=complete`);
  } catch (error) {
    logger.error('Erreur lors du retour d\'onboarding PayPal', {
      error: error instanceof Error ? error.message : String(error),
      trackingId
    });
    return res.redirect(`${frontendSettings}?paypal_error=server_error`);
  }
};

/**
 * Statut d'onboarding PayPal du vendeur (merchant ID, drapeaux, permissions).
 * `?refresh=true` force un appel « show seller status » auprès de PayPal.
 */
export const checkPayPalConnection = async (req: Request, res: Response) => {
  const status = await getPayPalAccountStatus(req.user!.id, {
    refresh: req.query.refresh === 'true'
  });

  res.status(200).json({ success: true, ...status });
};

/**
 * Déconnecte le compte PayPal du vendeur
 */
export const disconnectPayPal = async (req: Request, res: Response) => {
  await disconnectPayPalForUser(req.user!.id);

  res.status(200).json({
    success: true,
    message: 'Compte PayPal déconnecté avec succès'
  });
};

/**
 * Initie un paiement PayPal pour un produit
 */
export const initiatePayPalPayment = async (req: Request, res: Response) => {
  const { productId, shippingMethod, shippingAddress } = req.body;

  const paymentResponse = await initiateDirectPayment(req.user!.id, productId, {
    shippingMethod,
    shippingAddress
  });

  res.status(200).json({
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
};

/**
 * Capture un paiement après approbation par l'acheteur
 */
export const capturePayPalPayment = async (req: Request, res: Response) => {
  const result = await captureDirectPayment(req.user!.id, req.body.orderId);

  res.status(200).json({
    success: true,
    payment: result,
    message: 'Paiement capturé avec succès'
  });
};

/**
 * Annule un paiement PayPal en attente
 */
export const cancelPayPalPayment = async (req: Request, res: Response) => {
  const result = await cancelDirectPayment(req.user!.id, req.body.orderId);
  res.status(200).json({ success: true, ...result });
};

/**
 * Confirme un paiement après redirection depuis PayPal
 */
export const confirmPayPalPayment = async (req: Request, res: Response) => {
  const { orderId } = req.query;
  const frontend = env.FRONTEND_URL;

  // Redirection de navigateur : une erreur renvoie vers la page d'erreur du front.
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
};

/**
 * Gère les webhooks PayPal pour les notifications automatiques de paiement
 * @route POST /api/payments/webhook/paypal
 * @access public - Ne nécessite pas d'authentification (appelé par PayPal)
 *
 * Un échec de traitement remonte en 5xx : PayPal redélivre alors l'événement.
 * C'est sans risque, le traitement étant idempotent (completePayment, registre
 * des remboursements). Un événement ignoré ou déjà traité répond 200.
 */
export const handleWebhook = async (req: Request, res: Response) => {
  const event = req.body;

  if (!event || !event.event_type) {
    logger.warn('Webhook PayPal reçu avec un format invalide');
    throw badRequest('Format de webhook invalide', 'INVALID_WEBHOOK');
  }

  logger.debug('Webhook PayPal reçu', {
    eventType: event.event_type,
    eventId: event.id,
    resourceType: event.resource_type || 'non spécifié'
  });

  // Vérification systématique de la signature : sans elle, n'importe qui
  // connaissant l'URL peut forger un PAYMENT.CAPTURE.COMPLETED et faire
  // passer une commande en payée.
  if (!(await isAuthenticWebhook(req.headers, event))) {
    throw new HttpError(401, 'Signature de webhook invalide', 'INVALID_WEBHOOK_SIGNATURE');
  }

  await PayPalService.handleWebhook(event);

  res.status(200).json({
    received: true,
    eventType: event.event_type
  });
};

/**
 * Vérifie et met à jour le statut d'un paiement
 */
export const checkPaymentStatus = async (req: Request, res: Response) => {
  const { status, payment } = await fetchPaymentStatus(req.user!.id, String(req.params.paymentId));

  res.status(200).json({
    success: true,
    status,
    payment
  });
};

/**
 * Effectue un remboursement total ou partiel pour un paiement
 * @route POST /api/payments/:paymentId/refund
 * @access Private - Vendeur ou admin
 *
 * Initie le remboursement côté PayPal. La mise à jour de l'état du Payment
 * (status, refundAmount, refundedAt) est assurée par le webhook PAYMENT.CAPTURE.REFUNDED.
 */
export const refundPayment = async (req: Request, res: Response) => {
  const { amount, reason, password } = req.body;

  const refund = await processRefund({
    userId: req.user!.id,
    paymentId: String(req.params.paymentId),
    amount,
    reason,
    password
  });

  res.status(200).json({
    success: true,
    message: 'Remboursement initié avec succès',
    refund
  });
};

/**
 * Récupère la liste des paiements de l'utilisateur
 */
export const getMyPayments = async (req: Request, res: Response) => {
  const { data, pagination } = await listUserPayments(
    req.user!.id,
    { role: queryString(req.query.role) || 'all', status: queryString(req.query.status) },
    parsePagination(req.query, { defaultLimit: MY_PAYMENTS_DEFAULT_LIMIT })
  );

  res.status(200).json({
    success: true,
    data,
    pagination
  });
};

/**
 * Le vendeur enregistre l'expédition (transporteur + numéro de suivi).
 * @route POST /api/payments/:paymentId/shipment
 * @access Private - Vendeur uniquement
 */
export const createShipment = async (req: Request, res: Response) => {
  const { carrier, trackingNumber, trackingUrl } = req.body;

  const shipment = await markShipped({
    userId: req.user!.id,
    paymentId: String(req.params.paymentId),
    carrier,
    trackingNumber,
    trackingUrl
  });

  res.status(201).json({ success: true, shipment });
};

/**
 * L'acheteur confirme la réception du colis.
 * @route POST /api/payments/:paymentId/shipment/delivered
 * @access Private - Acheteur uniquement
 */
export const markShipmentDelivered = async (req: Request, res: Response) => {
  const shipment = await confirmDelivery(req.user!.id, String(req.params.paymentId));
  res.status(200).json({ success: true, shipment });
};

/**
 * Récupère les infos de suivi d'un paiement.
 * @route GET /api/payments/:paymentId/shipment
 * @access Private - Acheteur ou vendeur du paiement
 */
export const fetchShipment = async (req: Request, res: Response) => {
  const shipment = await getShipment(req.user!.id, String(req.params.paymentId));
  res.status(200).json({ success: true, shipment });
};
