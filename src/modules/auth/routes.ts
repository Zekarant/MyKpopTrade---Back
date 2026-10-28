import { Router } from 'express';
import passport from 'passport';
import * as loginController from './controllers/loginController';
import * as registerController from './controllers/registerController';
import * as emailVerificationController from './controllers/emailVerificationController';
import * as phoneVerificationController from './controllers/phoneVerificationController';
import * as passwordController from './controllers/passwordController';
import * as profileController from './controllers/profileController';
import * as socialAuthController from './controllers/socialAuthController';
import * as twoFactorController from './controllers/twoFactorController';
import { authenticateJWT } from '../../commons/middlewares/authMiddleware';
import {
  rateLimitLogin,
  rateLimitRegister,
  rateLimitEmailDispatch,
  rateLimitSmsDispatch,
  rateLimitSmsVerify,
  rateLimitTwoFactorVerify
} from './middleware/authRateLimiter';

const router = Router();

// Routes d'enregistrement et de connexion
router.post('/register', rateLimitRegister, registerController.register);
router.post('/login', rateLimitLogin, loginController.login);
// Sans authenticateJWT : se déconnecter doit rester possible une fois le jeton
// d'accès expiré.
router.post('/logout', loginController.logout);
router.post('/refresh-token', loginController.refreshToken);

// Routes de vérification d'email
router.get('/verify-email/:token', emailVerificationController.verifyEmail);
router.post('/resend-verification', rateLimitEmailDispatch, emailVerificationController.resendVerification);

// Routes de réinitialisation de mot de passe
router.post('/forgot-password', rateLimitEmailDispatch, passwordController.forgotPassword);
router.post('/reset-password/:token', rateLimitLogin, passwordController.resetPassword);
router.put('/update-password', authenticateJWT, passwordController.updatePassword);

// Routes de double authentification (TOTP)
// La vérification du défi est publique : elle est protégée par le jeton de défi
// émis à la connexion, pas par une session déjà établie.
router.post('/2fa/verify', rateLimitTwoFactorVerify, twoFactorController.verifyChallenge);
router.get('/2fa/status', authenticateJWT, twoFactorController.status);
router.post('/2fa/setup', authenticateJWT, twoFactorController.setup);
router.post('/2fa/enable', authenticateJWT, twoFactorController.enable);
router.post('/2fa/disable', authenticateJWT, twoFactorController.disable);
router.post('/2fa/recovery-codes', authenticateJWT, twoFactorController.regenerate);

// Routes de vérification téléphonique
router.post('/send-phone-verification', authenticateJWT, rateLimitSmsDispatch, phoneVerificationController.sendVerificationCode);
router.post('/verify-phone', authenticateJWT, rateLimitSmsVerify, phoneVerificationController.verifyPhoneNumber);

// Routes de profil
router.get('/profile', authenticateJWT, profileController.getProfile);
router.put('/profile', authenticateJWT, profileController.updateProfile);
router.post('/profile/complete', authenticateJWT, profileController.completeProfile);
router.put('/profile/paypal-email', authenticateJWT, profileController.updatePayPalEmail);
router.delete('/profile/paypal-email', authenticateJWT, profileController.removePayPalEmail);

// Fin de connexion OAuth : le front échange le code reçu contre les jetons.
router.post('/oauth/exchange', socialAuthController.exchangeOAuthCode);

// Routes d'authentification sociale - LOGIN/REGISTER
router.get('/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
router.get('/google/callback', socialAuthController.googleCallback);

router.get('/facebook', passport.authenticate('facebook', { scope: ['email'] }));
router.get('/facebook/callback', socialAuthController.facebookCallback);

router.get('/discord', passport.authenticate('discord', { scope: ['identify', 'email'] }));
router.get('/discord/callback', socialAuthController.discordCallback);

// Routes de LIAISON de comptes sociaux (utilisateur déjà connecté).
router.post('/link/:provider', authenticateJWT, socialAuthController.issueLinkTicket);
for (const provider of Object.keys(socialAuthController.LINK_SCOPES) as socialAuthController.LinkProvider[]) {
  router.get(`/${provider}/link`, socialAuthController.startLink(provider));
}

export default router;