import { Router } from 'express';
import passport from 'passport';
import * as loginController from './controllers/loginController';
import * as registerController from './controllers/registerController';
import * as emailVerificationController from './controllers/emailVerificationController';
import * as phoneVerificationController from './controllers/phoneVerificationController';
import * as passwordController from './controllers/passwordController';
import * as profileController from './controllers/profileController';
import * as socialAuthController from './controllers/socialAuthController';
import { authenticateJWT } from '../../commons/middlewares/authMiddleware';

const router = Router();

// Routes d'enregistrement et de connexion
router.post('/register', registerController.register);
router.post('/login', loginController.login);
router.post('/logout', authenticateJWT, loginController.logout);
router.post('/refresh-token', loginController.refreshToken);

// Routes de vérification d'email
router.get('/verify-email/:token', emailVerificationController.verifyEmail);
router.post('/resend-verification', emailVerificationController.resendVerification);

// Routes de réinitialisation de mot de passe
router.post('/forgot-password', passwordController.forgotPassword);
router.post('/reset-password/:token', passwordController.resetPassword);
router.put('/update-password', authenticateJWT, passwordController.updatePassword);

// Routes de vérification téléphonique
router.post('/send-phone-verification', authenticateJWT, phoneVerificationController.sendVerificationCode);
router.post('/verify-phone', authenticateJWT, phoneVerificationController.verifyPhoneNumber);

// Routes de profil
router.get('/profile', authenticateJWT, profileController.getProfile);
router.put('/profile', authenticateJWT, profileController.updateProfile);
router.delete('/delete-account', authenticateJWT, profileController.deleteAccount);

// Routes d'authentification sociale
router.get('/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
router.get('/google/callback', 
  passport.authenticate('google', { session: false, failureRedirect: '/login?error=google' }),
  socialAuthController.oauthCallback
);

router.get('/facebook', passport.authenticate('facebook', { scope: ['email'] }));
router.get('/facebook/callback', 
  passport.authenticate('facebook', { session: false, failureRedirect: '/login?error=facebook' }),
  socialAuthController.oauthCallback
);

router.get('/discord', passport.authenticate('discord', { scope: ['identify', 'email'] }));
router.get('/discord/callback', 
  passport.authenticate('discord', { session: false, failureRedirect: '/login?error=discord' }),
  socialAuthController.oauthCallback
);

export default router;