import express from 'express';
import * as paymentController from './controllers/paymentController';
import { authenticateJWT } from '../../commons/middlewares/authMiddleware';
import { sanitizeInputs } from '../../commons/middlewares/sanitizeMiddleware';
import { validatePaymentConfig } from '../../config/paymentConfig';
import { validateRefundRequest } from '../../commons/middlewares/validationMiddleware';

// Valider la configuration au démarrage
validatePaymentConfig();

const router = express.Router();

// Appliquer la sanitisation pour toutes les routes
router.use(sanitizeInputs);

// Webhook PayPal (sans authentification)
router.post('/webhook/paypal', paymentController.handleWebhook);

// Routes nécessitant une authentification
router.use(authenticateJWT);

// Routes spécifiques d'abord (pour éviter les conflits avec les routes paramétrées)
router.get('/my', paymentController.getMyPayments);

// Routes de gestion de connexion PayPal
router.get('/paypal/connect', paymentController.generateConnectUrl);
router.get('/paypal/connection-status', paymentController.checkPayPalConnection);
router.post('/paypal/disconnect', paymentController.disconnectPayPal);

// Routes de paiement PayPal
router.post('/paypal/create', paymentController.initiatePayPalPayment);
router.post('/paypal/capture', paymentController.capturePayPalPayment);
router.get('/paypal/confirm', paymentController.confirmPayPalPayment);

// Routes avec paramètres ensuite
router.post('/:paymentId/refund', validateRefundRequest, paymentController.refundPayment);
router.get('/:paymentId', paymentController.checkPaymentStatus);

export default router;