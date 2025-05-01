import { Router } from 'express';
import passport from 'passport';
import * as authController from '../controllers/authController';

const router = Router();

// Routes d'inscription et connexion classique
router.post('/register', authController.register);
router.post('/login', authController.login);
router.post('/logout', authController.verifyToken, authController.logout);

// Routes de vérification d'email
router.get('/verify-email/:token', authController.verifyEmail);
router.post('/resend-verification', authController.resendVerificationEmail);

// Routes de réinitialisation de mot de passe
router.post('/forgot-password', authController.forgotPassword);
router.post('/reset-password/:token', authController.resetPassword);

// Routes de vérification du téléphone
router.post('/send-phone-verification', authController.verifyToken, authController.sendPhoneVerification);
router.post('/verify-phone', authController.verifyToken, authController.verifyPhone);

// Routes de gestion du profil
router.get('/profile', authController.verifyToken, authController.getProfile);
router.put('/profile', authController.verifyToken, authController.updateProfile);
router.put('/update-password', authController.verifyToken, authController.updatePassword);
router.delete('/delete-account', authController.verifyToken, authController.deleteAccount);

// Routes d'authentification sociale
// Google
router.get('/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
router.get('/google/callback', 
  passport.authenticate('google', { session: false, failureRedirect: '/login?error=google' }),
  authController.socialAuthCallback
);

// Facebook
router.get('/facebook', passport.authenticate('facebook', { scope: ['email'] }));
router.get('/facebook/callback', 
  passport.authenticate('facebook', { session: false, failureRedirect: '/login?error=facebook' }),
  authController.socialAuthCallback
);

// Discord
router.get('/discord', passport.authenticate('discord', { scope: ['identify', 'email'] }));
router.get('/discord/callback', 
  passport.authenticate('discord', { session: false, failureRedirect: '/login?error=discord' }),
  authController.socialAuthCallback
);

export default router;