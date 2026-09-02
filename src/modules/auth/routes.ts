import { Router, Request, Response, NextFunction } from 'express';
import passport from 'passport';
import jwt from 'jsonwebtoken';
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
import env from '../../config/env';

const router = Router();

// Routes d'enregistrement et de connexion
router.post('/register', rateLimitRegister, registerController.register);
router.post('/login', rateLimitLogin, loginController.login);
router.post('/logout', authenticateJWT, loginController.logout);
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
router.delete('/delete-account', authenticateJWT, profileController.deleteAccount);
router.put('/profile/paypal-email', authenticateJWT, profileController.updatePayPalEmail);
router.delete('/profile/paypal-email', authenticateJWT, profileController.removePayPalEmail);

// Routes d'authentification sociale - LOGIN/REGISTER
router.get('/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
router.get('/google/callback', (req: Request, res: Response, next: NextFunction) => {
  // Vérifier si c'est un flow de liaison (state contient linkToken)
  const stateParam = req.query.state as string | undefined;
  if (stateParam) {
    try {
      const state = JSON.parse(stateParam);
      if (state.linkToken) {
        const decoded = jwt.verify(state.linkToken, env.JWT_SECRET) as any;
        (req as any).linkUserId = decoded.userId;
      }
    } catch {
      // State invalide ou pas un JSON de liaison - on continue en mode login normal
    }
  }

  passport.authenticate('google', { session: false }, (err: any, user: any, info: any) => {
    if (err || !user) {
      if ((req as any).linkUserId) {
        const code = info?.message || 'google_link_failed';
        return res.redirect(`${process.env.FRONTEND_URL}/settings?error=${code}`);
      }
      const code = info?.message || 'google_auth_failed';
      return res.redirect(`${process.env.FRONTEND_URL}/login?error=${code}`);
    }
    req.user = user;

    // Si c'est une liaison, rediriger vers settings avec succès
    if (info?.isLink) {
      return res.redirect(`${process.env.FRONTEND_URL}/settings?linked=google`);
    }

    (req as Request & { isNewUser?: boolean }).isNewUser = info?.isNew === true;
    return socialAuthController.oauthCallback(req, res);
  })(req, res, next);
});

router.get('/facebook', passport.authenticate('facebook', { scope: ['email'] }));
router.get('/facebook/callback', 
  passport.authenticate('facebook', { session: false, failureRedirect: '/login?error=facebook' }),
  socialAuthController.oauthCallback
);

router.get('/discord', passport.authenticate('discord', { scope: ['identify', 'email'] }));
router.get('/discord/callback', (req: Request, res: Response, next: NextFunction) => {
  // Vérifier si c'est un flow de liaison (state contient linkToken)
  const stateParam = req.query.state as string | undefined;
  let isLinkFlow = false;
  if (stateParam) {
    try {
      const state = JSON.parse(decodeURIComponent(stateParam));
      if (state.linkToken) {
        const decoded = jwt.verify(state.linkToken, env.JWT_SECRET) as any;
        (req as any).linkUserId = decoded.userId;
        isLinkFlow = true;
      }
    } catch (e) {
      console.error('Discord callback state parse error:', e);
    }
  }

  passport.authenticate('discord', { session: false, failWithError: true } as any, (err: any, user: any, info: any) => {
    if (err || !user) {
      console.error('Discord auth failed:', err?.message || info?.message || 'Unknown error');
      if (isLinkFlow) {
        return res.redirect(`${process.env.FRONTEND_URL}/settings?error=discord_link_failed&reason=${encodeURIComponent(err?.message || 'auth_failed')}`);
      }
      return res.redirect(`${process.env.FRONTEND_URL}/login?error=discord`);
    }
    req.user = user;

    // Si c'est une liaison, rediriger vers settings avec succès
    if (info?.isLink || isLinkFlow) {
      return res.redirect(`${process.env.FRONTEND_URL}/settings?linked=discord`);
    }

    return socialAuthController.oauthCallback(req, res);
  })(req, res, next);
});

// Routes de LIAISON de comptes sociaux (utilisateur déjà connecté)
// Le token JWT est passé en query param car window.location.href ne supporte pas les headers
router.get('/google/link', (req: Request, res: Response, next: NextFunction) => {
  const token = req.query.token as string;
  if (!token) {
    return res.redirect(`${process.env.FRONTEND_URL}/settings?error=no_token`);
  }

  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as any;
    const userId = decoded.id;
    const linkToken = jwt.sign(
      { userId, purpose: 'social_link' },
      env.JWT_SECRET,
      { expiresIn: '5m' }
    );
    passport.authenticate('google', {
      scope: ['profile', 'email'],
      state: JSON.stringify({ linkToken })
    })(req, res, next);
  } catch {
    return res.redirect(`${process.env.FRONTEND_URL}/settings?error=invalid_token`);
  }
});

router.get('/discord/link', (req: Request, res: Response, next: NextFunction) => {
  const token = req.query.token as string;
  if (!token) {
    return res.redirect(`${process.env.FRONTEND_URL}/settings?error=no_token`);
  }

  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as any;
    const userId = decoded.id;
    const linkToken = jwt.sign(
      { userId, purpose: 'social_link' },
      env.JWT_SECRET,
      { expiresIn: '5m' }
    );
    passport.authenticate('discord', {
      scope: ['identify', 'email'],
      state: JSON.stringify({ linkToken })
    })(req, res, next);
  } catch {
    return res.redirect(`${process.env.FRONTEND_URL}/settings?error=invalid_token`);
  }
});

export default router;