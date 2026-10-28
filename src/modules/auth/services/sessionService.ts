import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import User, { IUser } from '../../../models/userModel';
import env from '../../../config/env';
import {
  generateAccessToken,
  generateRefreshToken,
  invalidateRefreshToken,
  invalidateAllUserRefreshTokens,
  rotateRefreshToken,
  revokeAccessToken,
  JWT_VERIFY_OPTIONS
} from '../../../commons/services/tokenService';
import { HttpError } from '../../../commons/utils/httpError';
import logger from '../../../commons/utils/logger';
import { isTwoFactorEnabled, issueTwoFactorChallengeToken } from './twoFactorService';
import { accountSuspendedError, maskUserId } from './authCommon';

/**
 * Empreinte bcrypt (même coût que les vrais mots de passe) comparée quand le
 * compte n'existe pas : la réponse prend alors le même temps, et ne révèle pas
 * quels identifiants ont un compte.
 */
const DUMMY_PASSWORD_HASH = '$2b$10$v.0iX5kb.g6SF.4uGSbCiO.QZLrO5BcDOwfIoEU7nfxBJurfArh0q';

const INVALID_CREDENTIALS_MESSAGE = 'Identifiants incorrects';

/** Jetons d'une session ouverte ; le refresh token part dans un cookie HttpOnly. */
export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
}

export async function openSession(user: IUser): Promise<SessionTokens> {
  return {
    accessToken: generateAccessToken(user),
    refreshToken: await generateRefreshToken(user._id.toString())
  };
}

/** Utilisateur et consentements rendus au front à l'ouverture d'une session. */
export function sessionProfile(user: IUser) {
  return {
    user: {
      id: user._id,
      username: user.username,
      email: user.email,
      isEmailVerified: user.isEmailVerified,
      isPhoneVerified: user.isPhoneVerified,
      role: user.role
    },
    consents: {
      privacyPolicy: user.privacyPolicyAccepted,
      dataProcessing: user.dataProcessingConsent,
      marketing: user.marketingConsent
    }
  };
}

export type PasswordLoginResult =
  | { requiresTwoFactor: true; twoFactorToken: string }
  | { requiresTwoFactor: false; user: IUser; tokens: SessionTokens };

/**
 * Vérifie email/nom d'utilisateur + mot de passe. Avec la double
 * authentification active, rend un jeton de défi au lieu d'ouvrir la session.
 *
 * @throws HttpError 401 identifiants incorrects, 403 email non vérifié ou compte suspendu
 */
export async function loginWithPassword(identifier: string, password: string): Promise<PasswordLoginResult> {
  const user = await User.findOne({
    $or: [{ email: identifier }, { username: identifier }],
    accountStatus: { $ne: 'deleted' }
  }).select('+password');

  if (!user) {
    await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
    throw new HttpError(401, INVALID_CREDENTIALS_MESSAGE, 'INVALID_CREDENTIALS');
  }

  if (!(await user.comparePassword(password))) {
    throw new HttpError(401, INVALID_CREDENTIALS_MESSAGE, 'INVALID_CREDENTIALS');
  }

  if (!user.isEmailVerified) {
    throw new HttpError(403, 'Veuillez vérifier votre adresse email avant de vous connecter', 'EMAIL_NOT_VERIFIED');
  }

  if (user.accountStatus === 'suspended') {
    throw accountSuspendedError();
  }

  // Double authentification active : le mot de passe seul ne suffit pas. Le
  // jeton de défi n'est utilisable que sur /auth/2fa/verify.
  if (isTwoFactorEnabled(user)) {
    logger.info('Défi de double authentification émis', { userId: maskUserId(user._id.toString()) });
    return { requiresTwoFactor: true, twoFactorToken: issueTwoFactorChallengeToken(user._id.toString()) };
  }

  user.lastLogin = new Date();
  await user.save();

  logger.info('Connexion réussie', { userId: maskUserId(user._id.toString()), username: user.username });

  return { requiresTwoFactor: false, user, tokens: await openSession(user) };
}

function isValidAccessToken(token: string): boolean {
  try {
    jwt.verify(token, env.JWT_SECRET, JWT_VERIFY_OPTIONS);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ferme une session. La route n'exige pas de session (un jeton d'accès expiré
 * ne doit pas bloquer la déconnexion) : seul un jeton authentique et valide est révoqué.
 */
export async function closeSession({ accessToken, refreshToken }: { accessToken?: string; refreshToken?: string }) {
  if (accessToken && isValidAccessToken(accessToken)) {
    await revokeAccessToken(accessToken);
  }
  if (refreshToken) {
    await invalidateRefreshToken(refreshToken);
  }
}

export type SessionRenewal = SessionTokens | { failure: string };

/**
 * Échange un refresh token contre un nouveau couple de jetons. Le jeton présenté
 * est consommé ; un échec rend le motif à afficher, la session étant alors perdue.
 */
export async function renewSession(refreshToken: string): Promise<SessionRenewal> {
  const rotated = await rotateRefreshToken(refreshToken);
  if (!rotated) {
    return { failure: 'Refresh token invalide ou expiré' };
  }

  const user = await User.findById(rotated.userId);
  if (!user || user.accountStatus === 'deleted') {
    await invalidateAllUserRefreshTokens(rotated.userId);
    return { failure: 'Utilisateur non trouvé ou compte supprimé' };
  }

  return { accessToken: generateAccessToken(user), refreshToken: rotated.refreshToken };
}
