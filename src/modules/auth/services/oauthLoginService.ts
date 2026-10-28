import jwt from 'jsonwebtoken';
import User, { IUser } from '../../../models/userModel';
import env from '../../../config/env';
import { readOAuthState } from '../../../config/oauthStateStore';
import { JWT_VERIFY_OPTIONS } from '../../../commons/services/tokenService';
import { HttpError } from '../../../commons/utils/httpError';
import { issueOneTimeCode, consumeOneTimeCode } from './oneTimeCodeService';
import { isTwoFactorEnabled, issueTwoFactorChallengeToken } from './twoFactorService';
import { accountSuspendedError } from './authCommon';

/** `purpose` du jeton court qui transporte l'utilisateur à lier dans le `state` OAuth. */
const SOCIAL_LINK_TOKEN_PURPOSE = 'social_link';

/** Le parcours de consentement chez le fournisseur doit tenir dans ce délai. */
const SOCIAL_LINK_TOKEN_EXPIRES_IN = '5m';

/**
 * Utilisateur à qui lier le compte social, lu dans le `state` OAuth ; undefined
 * pour un parcours de connexion. L'authenticité du `state` (nonce ↔ cookie)
 * est vérifiée par passport avant tout usage du code d'autorisation.
 */
export function linkUserIdFromState(rawState: unknown): string | undefined {
  const linkToken = readOAuthState(rawState)?.linkToken;
  if (!linkToken) return undefined;
  try {
    const decoded = jwt.verify(linkToken, env.JWT_SECRET, JWT_VERIFY_OPTIONS) as { userId?: string; purpose?: string };
    // Même secret que le défi 2FA (qui porte aussi `userId`) : sans ce
    // contrôle, un défi 2FA servirait de jeton de liaison.
    return decoded.purpose === SOCIAL_LINK_TOKEN_PURPOSE ? decoded.userId : undefined;
  } catch {
    // Jeton expiré ou falsifié : parcours de connexion normal.
    return undefined;
  }
}

/**
 * Ticket à usage unique (une minute) qui lance la liaison d'un compte social.
 * Une redirection ne peut pas porter d'en-tête Authorization : l'URL porte ce
 * ticket, jamais le jeton d'accès.
 */
export function issueSocialLinkTicket(userId: string): Promise<string> {
  return issueOneTimeCode(userId, 'social_link');
}

/**
 * Consomme le ticket de liaison et rend le jeton à placer dans le `state` OAuth.
 * @returns null si le ticket est inconnu, expiré ou déjà utilisé
 */
export async function redeemSocialLinkTicket(ticket: string): Promise<string | null> {
  const userId = await consumeOneTimeCode(ticket, 'social_link');
  if (!userId) return null;
  return jwt.sign(
    { userId, purpose: SOCIAL_LINK_TOKEN_PURPOSE },
    env.JWT_SECRET,
    { expiresIn: SOCIAL_LINK_TOKEN_EXPIRES_IN }
  );
}

export type OAuthLoginOutcome =
  | { requiresTwoFactor: true; twoFactorToken: string }
  | { requiresTwoFactor: false; code: string; requiresProfileCompletion: boolean };

/**
 * Fin d'une connexion OAuth réussie chez le fournisseur.
 *
 * Avec la 2FA active, l'OAuth remplace le mot de passe, pas le second facteur :
 * même défi que /auth/login. Sinon, un code à usage unique que le front échange
 * sur POST /api/auth/oauth/exchange — les jetons ne passent jamais dans l'URL
 * (historique du navigateur, journaux du serveur du front).
 */
export async function completeOAuthLogin(user: IUser): Promise<OAuthLoginOutcome> {
  const userId = String(user._id);
  if (isTwoFactorEnabled(user)) {
    return { requiresTwoFactor: true, twoFactorToken: issueTwoFactorChallengeToken(userId) };
  }
  return {
    requiresTwoFactor: false,
    code: await issueOneTimeCode(userId, 'oauth_login'),
    requiresProfileCompletion: user.profileCompleted === false
  };
}

/**
 * Échange le code de fin de connexion OAuth contre l'utilisateur à connecter.
 * @throws HttpError 401 OAUTH_CODE_INVALID, 403 ACCOUNT_SUSPENDED
 */
export async function exchangeOAuthLoginCode(code: string): Promise<IUser> {
  const userId = await consumeOneTimeCode(code, 'oauth_login');
  const user = userId ? await User.findById(userId) : null;
  if (!user || user.accountStatus === 'deleted') {
    throw new HttpError(401, 'Connexion expirée. Recommencez.', 'OAUTH_CODE_INVALID');
  }
  if (user.accountStatus === 'suspended') {
    throw accountSuspendedError();
  }
  return user;
}
