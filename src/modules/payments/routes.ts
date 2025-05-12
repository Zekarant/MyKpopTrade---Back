import express from 'express';
import * as paymentController from './controllers/paymentController';
import * as paymentGdprController from './controllers/paymentGdprController';
import { authenticateJWT, requireAdmin } from '../../commons/middlewares/authMiddleware';
import { sanitizeInputs } from '../../commons/middlewares/sanitizeMiddleware';
import { validatePaymentConfig } from '../../config/paymentConfig';
import { validateRefundRequest, validatePassword } from '../../commons/middlewares/validationMiddleware';
import { dataBreachDetection } from '../../commons/middlewares/dataBreachDetectionMiddleware';

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
router.get('/my', dataBreachDetection('payment_history'), paymentController.getMyPayments);

// Routes RGPD pour les paiements (nécessitent l'authentification)
router.get('/export', 
  dataBreachDetection('payment_export'), 
  paymentGdprController.exportPaymentData
);

router.post('/gdpr/anonymize', 
  validatePassword, 
  paymentGdprController.anonymizeUserPaymentData
);

// Route administrative (nécessite un rôle admin)
router.post('/gdpr/anonymize-old-payments', 
  requireAdmin, 
  paymentGdprController.anonymizeOldPayments
);

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
router.get('/:paymentId', dataBreachDetection('payment_details'), paymentController.checkPaymentStatus);

export default router;