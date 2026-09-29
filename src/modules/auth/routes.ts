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
import { readOAuthState, OAuthAppState } from '../../config/oauthStateStore';
import { issueOneTimeCode, consumeOneTimeCode } from './services/oneTimeCodeService';

const router = Router();

/** `purpose` du jeton court qui transporte l'utilisateur à lier dans le `state` OAuth. */
const SOCIAL_LINK_TOKEN_PURPOSE = 'social_link';

/**
 * Transporte le jeton de liaison dans le state OAuth. Un objet, et non une
 * chaîne, pour que passport passe par CookieStateStore.
 */
function linkState(linkToken: string): string {
  const state: OAuthAppState = { linkToken };
  return state as unknown as string;
}

function linkUserIdFromState(rawState: unknown): string | undefined {
  const linkToken = readOAuthState(rawState)?.linkToken;
  if (!linkToken) return undefined;
  try {
    const decoded = jwt.verify(linkToken, env.JWT_SECRET) as { userId?: string; purpose?: string };
    // Même secret que le défi 2FA (qui porte aussi `userId`) : sans ce
    // contrôle, un défi 2FA servirait de jeton de liaison.
    return decoded.purpose === SOCIAL_LINK_TOKEN_PURPOSE ? decoded.userId : undefined;
  } catch {
    // Jeton expiré ou falsifié : parcours de connexion normal.
    return undefined;
  }
}

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
router.delete('/delete-account', authenticateJWT, profileController.deleteAccount);
router.put('/profile/paypal-email', authenticateJWT, profileController.updatePayPalEmail);
router.delete('/profile/paypal-email', authenticateJWT, profileController.removePayPalEmail);

// Fin de connexion OAuth : le front échange le code reçu contre les jetons.
router.post('/oauth/exchange', socialAuthController.exchangeOAuthCode);

// Routes d'authentification sociale - LOGIN/REGISTER
router.get('/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
router.get('/google/callback', (req: Request, res: Response, next: NextFunction) => {
  // L'authenticité du state (nonce ↔ cookie) est vérifiée par passport, avant
  // tout usage du code.
  const linkUserId = linkUserIdFromState(req.query.state);
  if (linkUserId) req.linkUserId = linkUserId;

  passport.authenticate('google', { session: false }, (err: any, user: any, info: any) => {
    if (err || !user) {
      if (req.linkUserId) {
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
  const linkUserId = linkUserIdFromState(req.query.state);
  const isLinkFlow = Boolean(linkUserId);
  if (linkUserId) req.linkUserId = linkUserId;

  passport.authenticate('discord', { session: false, failWithError: true } as any, (err: any, user: any, info: any) => {
    if (err || !user) {
      console.error('Discord auth failed:', err?.message || info?.message || 'Unknown error');
      if (isLinkFlow) {
        return res.redirect(`${process.env.FRONTEND_URL}/settings?error=discord_link_failed&reason=${encodeURIComponent(err?.message || 'auth_failed')}`);
      }
      const code = encodeURIComponent(info?.message || 'discord_auth_failed');
      return res.redirect(`${process.env.FRONTEND_URL}/login?error=${code}`);
    }
    req.user = user;

    // Si c'est une liaison, rediriger vers settings avec succès
    if (info?.isLink || isLinkFlow) {
      return res.redirect(`${process.env.FRONTEND_URL}/settings?linked=discord`);
    }

    return socialAuthController.oauthCallback(req, res);
  })(req, res, next);
});

// Routes de LIAISON de comptes sociaux (utilisateur déjà connecté).
// Une redirection ne peut pas porter d'en-tête Authorization : l'URL porte un
// ticket à usage unique (une minute), jamais le jeton d'accès.
const LINK_SCOPES = { google: ['profile', 'email'], discord: ['identify', 'email'] } as const;
type LinkProvider = keyof typeof LINK_SCOPES;
const isLinkProvider = (value: unknown): value is LinkProvider =>
  value === 'google' || value === 'discord';

router.post('/link/:provider', authenticateJWT, async (req: Request, res: Response) => {
  if (!isLinkProvider(req.params.provider)) {
    return res.status(404).json({ message: 'Fournisseur inconnu.' });
  }
  const ticket = await issueOneTimeCode(req.user!.id, 'social_link');
  return res.status(200).json({ ticket });
});

for (const provider of Object.keys(LINK_SCOPES) as LinkProvider[]) {
  router.get(`/${provider}/link`, async (req: Request, res: Response, next: NextFunction) => {
    const ticket = req.query.ticket;
    if (typeof ticket !== 'string' || !ticket) {
      return res.redirect(`${process.env.FRONTEND_URL}/settings?error=no_token`);
    }

    try {
      const userId = await consumeOneTimeCode(ticket, 'social_link');
      if (!userId) {
        return res.redirect(`${process.env.FRONTEND_URL}/settings?error=invalid_token`);
      }
      const linkToken = jwt.sign(
        { userId, purpose: SOCIAL_LINK_TOKEN_PURPOSE },
        env.JWT_SECRET,
        { expiresIn: '5m' }
      );
      return passport.authenticate(provider, {
        scope: [...LINK_SCOPES[provider]],
        state: linkState(linkToken)
      })(req, res, next);
    } catch (error) {
      return next(error);
    }
  });
}

export default router;