import express from 'express';
import * as paymentController from './controllers/paymentController';
import { authenticateJWT } from '../../commons/middlewares/authMiddleware';
import { sanitizeInputs } from '../../commons/middlewares/sanitizeMiddleware';
import { validatePaymentConfig } from '../../config/paymentConfig';

// Valider la configuration au démarrage
validatePaymentConfig();

const router = express.Router();

// Appliquer la sanitisation pour toutes les routes
router.use(sanitizeInputs);

// Routes nécessitant une authentification
router.use(authenticateJWT);

// Initier un paiement PayPal
router.post('/paypal/create', paymentController.initiatePayPalPayment);

// Capturer un paiement après approbation
router.post('/paypal/capture', paymentController.capturePayPalPayment);

// Vérifier le statut d'un paiement
router.get('/:paymentId', paymentController.checkPaymentStatus);

// Historique des paiements de l'utilisateur
router.get('/', paymentController.getMyPayments);

// Rembourser un paiement (vendeur uniquement)
router.post('/:paymentId/refund', paymentController.refundPayment);

export default router;