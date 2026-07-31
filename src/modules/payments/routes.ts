import express from 'express';
import * as paymentController from './controllers/paymentController';
import * as paymentGdprController from './controllers/paymentGdprController';
import * as stripeController from './controllers/stripeController';
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

// Retour d'onboarding PayPal (sans authentification — le vendeur est redirigé
// par PayPal ; le rapprochement se fait sur le tracking_id)
router.get('/paypal/onboarding-return', paymentController.handleOnboardingReturn);

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

// Onboarding vendeur PayPal (Connected Path / Partner Referrals)
router.post('/paypal/onboarding-link', paymentController.generateOnboardingLink);
router.get('/paypal/account-status', paymentController.checkPayPalConnection);
router.post('/paypal/disconnect', paymentController.disconnectPayPal);

// Routes de paiement PayPal
router.post('/paypal/create', paymentController.initiatePayPalPayment);
router.post('/paypal/capture', paymentController.capturePayPalPayment);
router.post('/paypal/cancel', paymentController.cancelPayPalPayment);
router.get('/paypal/confirm', paymentController.confirmPayPalPayment);

// Routes Stripe Connect (onboarding + checkout + refund)
// Note : POST /api/payments/stripe/webhook est monté DIRECTEMENT dans app.ts
// avec express.raw() — il n'apparaît pas ici car il doit by-pass express.json().
router.post('/stripe/onboarding-link', stripeController.generateStripeOnboardingLink);
router.get('/stripe/account-status', stripeController.checkStripeAccountStatus);
router.post('/stripe/checkout', stripeController.initiateStripeCheckout);
router.post('/stripe/:paymentId/refund', validateRefundRequest, stripeController.refundStripePaymentEndpoint);

// Routes avec paramètres ensuite
router.post('/:paymentId/refund', validateRefundRequest, paymentController.refundPayment);
router.post('/:paymentId/shipment/delivered', paymentController.markShipmentDelivered);
router.post('/:paymentId/shipment', paymentController.createShipment);
router.get('/:paymentId/shipment', paymentController.fetchShipment);
router.get('/:paymentId', dataBreachDetection('payment_details'), paymentController.checkPaymentStatus);

export default router;