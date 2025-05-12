import express from 'express';
import { authenticateJWT } from '../../commons/middlewares/authMiddleware';
import { sanitizeInputs } from '../../commons/middlewares/sanitizeMiddleware';
import * as sellerController from './controllers/sellerController';

const router = express.Router();

// Appliquer la sanitisation pour toutes les routes
router.use(sanitizeInputs);

// Routes protégées
router.use(authenticateJWT);

// Routes du profil vendeur
router.get('/seller/profile', sellerController.getSellerProfile);
router.put('/seller/paypal-email', sellerController.updatePayPalEmail);

export default router;