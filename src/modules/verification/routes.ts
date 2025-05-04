import express from 'express';
import multer from 'multer';
import * as identityVerificationController from './controllers/identityVerificationController';
import { authenticateJWT } from '../../commons/middlewares/authMiddleware';
import { requireAdmin } from '../../commons/middlewares/roleMiddleware';

const router = express.Router();

// Configuration de Multer pour stocker temporairement en mémoire
const storage = multer.memoryStorage();
const upload = multer({ 
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024 // limite à 5MB
  }
});

// Routes utilisateur
router.post(
  '/identity', 
  authenticateJWT, 
  upload.single('document'), 
  identityVerificationController.submitVerification
);
router.get(
  '/identity/status', 
  authenticateJWT, 
  identityVerificationController.checkVerificationStatus
);
router.delete(
  '/identity/cancel', 
  authenticateJWT, 
  identityVerificationController.cancelVerification
);

// Routes administrateur
router.get(
  '/admin/pending',
  authenticateJWT,
  requireAdmin,
  identityVerificationController.getPendingVerifications
);

// Vérifiez que le paramètre est cohérent
router.post(
  '/admin/approve/:id', // Assurez-vous que c'est bien :id et non :verificationId
  authenticateJWT,
  requireAdmin,
  identityVerificationController.approveVerification
);

router.post(
  '/admin/reject/:id',  // Assurez-vous que c'est :id et non :verificationId
  authenticateJWT,
  requireAdmin,
  identityVerificationController.rejectVerification
);

export default router;