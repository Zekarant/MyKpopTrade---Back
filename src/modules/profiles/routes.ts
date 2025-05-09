import { Router } from 'express';
import * as profileController from './controllers/profileController';
import * as ratingController from './controllers/ratingController';
import * as verificationController from './controllers/verificationController';
import { authenticateJWT } from '../../commons/middlewares/authMiddleware';
import { profilePictureUpload } from './middleware/fileUploaderMiddleware';

const router = Router();

// Routes de profil
router.get('/me', authenticateJWT, profileController.getMyProfile);
router.put('/me', authenticateJWT, profileController.updateProfile);
router.get('/user/:username', profileController.getPublicProfile);

// Routes d'évaluation
router.get('/ratings/:userId', ratingController.getUserRatings);
router.post('/ratings', authenticateJWT, ratingController.createRating);
router.post('/ratings/:ratingId/report', authenticateJWT, ratingController.reportRating);

// Routes de preuves de transaction
router.get('/proofs/:userId', verificationController.getUserProofs);
router.post('/proofs', authenticateJWT, verificationController.addTransactionProof);
router.get('/verification-stats/:userId', verificationController.getUserVerificationStats);

router.post(
    '/me/picture',
    authenticateJWT,
    profilePictureUpload.single('profilePicture'),
    profileController.updateProfilePicture
  );
  
  // Route pour supprimer la photo de profil
  router.delete(
    '/me/picture',
    authenticateJWT,
    profileController.deleteProfilePicture
  );

export default router;