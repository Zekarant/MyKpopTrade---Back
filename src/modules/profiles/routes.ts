import { Router } from 'express';
import * as profileController from './controllers/profileController';
import * as ratingController from './controllers/ratingController';
import * as transactionProofController from './controllers/transactionProofController';
import { authenticateJWT, optionalAuthenticateJWT } from '../../commons/middlewares/authMiddleware';
import { profilePictureUpload, ratingImageUpload, profileBannerUpload } from './middleware/fileUploaderMiddleware';

const router = Router();

// Routes de profil
// La mise à jour du profil passe par PUT /api/auth/profile.
router.get('/me', authenticateJWT, profileController.getMyProfile);
router.get('/user/:identifier', profileController.getPublicProfile);

// Routes d'évaluation (les signalements d'avis passent par /api/reports)
router.get('/ratings/:userId', ratingController.getUserRatings);
router.post('/ratings', authenticateJWT, ratingImageUpload.array('ratingImages', 5), ratingController.createRating);
router.post(
  '/ratings/:ratingId/images',
  authenticateJWT,
  ratingImageUpload.single('ratingImage'),
  ratingController.addRatingImage
);
router.delete(
  '/ratings/:ratingId/images',
  authenticateJWT,
  ratingController.deleteRatingImage
);

// Routes pour les réponses aux évaluations
router.post(
  '/ratings/:ratingId/response',
  authenticateJWT,
  ratingController.respondToRating
);

router.put(
  '/ratings/:ratingId/response',
  authenticateJWT,
  ratingController.updateRatingResponse
);

router.delete(
  '/ratings/:ratingId/response',
  authenticateJWT,
  ratingController.deleteRatingResponse
);

// Routes de preuves de transaction (la vérification d'identité est dans le
// module `verification`). Public ; `includeAll` n'est honoré que pour
// l'auteur des preuves ou un admin.
router.get('/proofs/:userId', optionalAuthenticateJWT, transactionProofController.getUserProofs);
router.post('/proofs', authenticateJWT, transactionProofController.addTransactionProof);
router.get('/verification-stats/:userId', transactionProofController.getUserVerificationStats);

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

// Route pour télécharger une bannière de profil
router.post(
  '/me/banner',
  authenticateJWT,
  profileBannerUpload.single('profileBanner'),
  profileController.updateProfileBanner
);

router.delete(
  '/me/banner',
  authenticateJWT,
  profileController.deleteProfileBanner
);

export default router;