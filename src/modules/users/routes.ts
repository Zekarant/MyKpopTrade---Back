import express from 'express';
import { authenticateJWT } from '../../commons/middlewares/authMiddleware';
import { addEmail } from './controllers/userEmailController';
import { searchUsers } from './controllers/userSearchController';
import * as userPrivacyController from './controllers/userPrivacyController';

const router = express.Router();

// Routes publiques

// Recherche utilisateur partielle
router.get('/search', searchUsers);

// Routes protégées
router.put('/me/consents', authenticateJWT, userPrivacyController.updateUserConsents);
router.get('/me/data-export', authenticateJWT, userPrivacyController.exportUserData);
router.post('/me/deletion-request', authenticateJWT, userPrivacyController.requestAccountDeletion);
router.delete('/me/deletion-request', authenticateJWT, userPrivacyController.cancelDeletionRequest);
router.post('/me/anonymize', authenticateJWT, userPrivacyController.anonymizeUserData);

export default router;