import { Request, Response, NextFunction } from 'express';
import passport from 'passport';
import { IUser } from '../../../models/userModel';
import env from '../../../config/env';
import { OAuthAppState } from '../../../config/oauthStateStore';
import { HttpError, notFound } from '../../../commons/utils/httpError';
import logger from '../../../commons/utils/logger';
import { openSession } from '../services/sessionService';
import {
  completeOAuthLogin,
  exchangeOAuthLoginCode,
  issueSocialLinkTicket,
  linkUserIdFromState,
  redeemSocialLinkTicket
} from '../services/oauthLoginService';
import { setRefreshTokenCookie } from './refreshTokenCookie';

/** Informations rendues par les stratégies passport (cf. config/passport.ts). */
interface OAuthCallbackInfo {
  message?: string;
  isLink?: boolean;
  isNew?: boolean;
}

/** Scopes demandés à chaque fournisseur lors d'une liaison de compte. */
export const LINK_SCOPES = { google: ['profile', 'email'], discord: ['identify', 'email'] } as const;
export type LinkProvider = keyof typeof LINK_SCOPES;

const isLinkProvider = (value: unknown): value is LinkProvider => value === 'google' || value === 'discord';

const frontendRedirect = (res: Response, pathAndQuery: string) => res.redirect(`${env.FRONTEND_URL}${pathAndQuery}`);

/**
 * Transporte le jeton de liaison dans le state OAuth. Un objet, et non une
 * chaîne, pour que passport passe par CookieStateStore.
 */
function linkState(linkToken: string): string {
  const state: OAuthAppState = { linkToken };
  return state as unknown as string;
}

/**
 * Fin de connexion OAuth réussie : redirige vers le front avec un code à
 * échanger (ou le défi 2FA). Le mode JSON (`?responseMode=json`) ouvre
 * directement la session ; il sert aux tests manuels du flux.
 */
export const oauthCallback = async (req: Request, res: Response): Promise<void> => {
  const user = req.user as IUser | undefined;
  const isJson = req.query.responseMode === 'json';
  const isNewUser = (req as Request & { isNewUser?: boolean }).isNewUser === true;

  if (!user) {
    if (isJson) throw new HttpError(401, 'Authentification échouée');
    frontendRedirect(res, '/login?error=auth_failed');
    return;
  }

  if (isJson) {
    await respondWithJsonSession(req, res, user, isNewUser);
    return;
  }

  let outcome;
  try {
    outcome = await completeOAuthLogin(user);
  } catch (error) {
    // Le navigateur est en pleine redirection : une réponse JSON laisserait
    // l'utilisateur sur une page d'erreur de l'API au lieu du front.
    logger.error('Erreur lors de l\'authentification sociale', {
      error: error instanceof Error ? error.message : String(error)
    });
    frontendRedirect(res, '/login?error=server_error');
    return;
  }

  if (outcome.requiresTwoFactor) {
    frontendRedirect(res, `/login?${new URLSearchParams({ twoFactorToken: outcome.twoFactorToken })}`);
    return;
  }

  const params = new URLSearchParams({ code: outcome.code });
  if (isNewUser) params.set('newAccount', '1');
  if (outcome.requiresProfileCompletion) params.set('completeProfile', '1');
  frontendRedirect(res, `/auth/callback?${params}`);
};

async function respondWithJsonSession(req: Request, res: Response, user: IUser, isNewUser: boolean) {
  const outcome = await completeOAuthLogin(user);
  if (outcome.requiresTwoFactor) {
    res.status(200).json({ requiresTwoFactor: true, twoFactorToken: outcome.twoFactorToken });
    return;
  }

  const tokens = await openSession(user);
  setRefreshTokenCookie(req, res, tokens.refreshToken);
  res.status(200).json({
    accessToken: tokens.accessToken,
    isNewUser,
    requiresProfileCompletion: outcome.requiresProfileCompletion,
    user: {
      id: user._id,
      username: user.username,
      email: user.email,
      isEmailVerified: user.isEmailVerified,
      isPhoneVerified: user.isPhoneVerified,
      profileCompleted: user.profileCompleted !== false
    }
  });
}

/**
 * Retour de Google : connexion, inscription ou liaison de compte.
 * @route GET /api/auth/google/callback
 */
export const googleCallback = (req: Request, res: Response, next: NextFunction): void => {
  const linkUserId = linkUserIdFromState(req.query.state);
  if (linkUserId) req.linkUserId = linkUserId;

  passport.authenticate('google', { session: false }, (err: Error | null, user?: Express.User | false, info?: OAuthCallbackInfo) => {
    if (err || !user) {
      const fallback = linkUserId ? 'google_link_failed' : 'google_auth_failed';
      const code = info?.message || fallback;
      frontendRedirect(res, linkUserId ? `/settings?error=${code}` : `/login?error=${code}`);
      return;
    }
    req.user = user;

    if (info?.isLink) {
      frontendRedirect(res, '/settings?linked=google');
      return;
    }

    (req as Request & { isNewUser?: boolean }).isNewUser = info?.isNew === true;
    oauthCallback(req, res).catch(next);
  })(req, res, next);
};

/**
 * Retour de Discord : connexion, inscription ou liaison de compte.
 * @route GET /api/auth/discord/callback
 */
export const discordCallback = (req: Request, res: Response, next: NextFunction): void => {
  const linkUserId = linkUserIdFromState(req.query.state);
  if (linkUserId) req.linkUserId = linkUserId;

  passport.authenticate('discord', { session: false, failWithError: true }, (err: Error | null, user?: Express.User | false, info?: OAuthCallbackInfo) => {
    if (err || !user) {
      logger.warn('Échec de l\'authentification Discord', {
        reason: err?.message || info?.message || 'Unknown error'
      });
      if (linkUserId) {
        frontendRedirect(res, `/settings?error=discord_link_failed&reason=${encodeURIComponent(err?.message || info?.message || 'auth_failed')}`);
        return;
      }
      frontendRedirect(res, `/login?error=${encodeURIComponent(info?.message || 'discord_auth_failed')}`);
      return;
    }
    req.user = user;

    if (info?.isLink || linkUserId) {
      frontendRedirect(res, '/settings?linked=discord');
      return;
    }

    oauthCallback(req, res).catch(next);
  })(req, res, next);
};

/**
 * Retour de Facebook (connexion ou inscription uniquement).
 * @route GET /api/auth/facebook/callback
 */
export const facebookCallback = (req: Request, res: Response, next: NextFunction): void => {
  passport.authenticate('facebook', { session: false }, (err: Error | null, user?: Express.User | false) => {
    if (err || !user) {
      frontendRedirect(res, '/login?error=facebook');
      return;
    }
    req.user = user;
    oauthCallback(req, res).catch(next);
  })(req, res, next);
};

/**
 * Délivre le ticket qui lance la liaison d'un compte social.
 * @route POST /api/auth/link/:provider
 */
export const issueLinkTicket = async (req: Request, res: Response): Promise<void> => {
  if (!isLinkProvider(req.params.provider)) {
    throw notFound('Fournisseur inconnu.', 'UNKNOWN_PROVIDER');
  }
  const ticket = await issueSocialLinkTicket(req.user!.id);
  res.status(200).json({ ticket });
};

/**
 * Lance la liaison chez le fournisseur à partir du ticket.
 * @route GET /api/auth/:provider/link
 */
export const startLink = (provider: LinkProvider) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const ticket = req.query.ticket;
    if (typeof ticket !== 'string' || !ticket) {
      frontendRedirect(res, '/settings?error=no_token');
      return;
    }

    const linkToken = await redeemSocialLinkTicket(ticket);
    if (!linkToken) {
      frontendRedirect(res, '/settings?error=invalid_token');
      return;
    }

    passport.authenticate(provider, {
      scope: [...LINK_SCOPES[provider]],
      state: linkState(linkToken)
    })(req, res, next);
  };

/**
 * Échange le code de fin de connexion OAuth contre les jetons de session.
 * @route POST /api/auth/oauth/exchange
 * @access Public — protégé par le code, à usage unique et valable une minute
 */
export const exchangeOAuthCode = async (req: Request, res: Response): Promise<void> => {
  const { code } = req.body;
  if (typeof code !== 'string' || !code) {
    throw new HttpError(400, 'Code de connexion requis.');
  }

  const user = await exchangeOAuthLoginCode(code);
  const tokens = await openSession(user);

  setRefreshTokenCookie(req, res, tokens.refreshToken);
  res.status(200).json({
    accessToken: tokens.accessToken,
    user: { id: user._id, username: user.username }
  });
};
