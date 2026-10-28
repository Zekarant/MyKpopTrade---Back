import { Request, Response } from 'express';
import { HttpError } from '../../../commons/utils/httpError';
import { loginWithPassword, closeSession, renewSession, sessionProfile } from '../services/sessionService';
import { setRefreshTokenCookie, clearRefreshTokenCookie, readRefreshTokenCookie } from './refreshTokenCookie';

/**
 * Connexion utilisateur
 * @route POST /api/auth/login
 */
export const login = async (req: Request, res: Response): Promise<void> => {
  const { identifier, password } = req.body;

  // Chaînes uniquement : un tableau deviendrait un `$in` dans la requête Mongo.
  if (typeof identifier !== 'string' || typeof password !== 'string' || !identifier || !password) {
    throw new HttpError(400, 'Email/nom d\'utilisateur et mot de passe sont requis');
  }

  const result = await loginWithPassword(identifier, password);

  if (result.requiresTwoFactor) {
    res.status(200).json({
      requiresTwoFactor: true,
      twoFactorToken: result.twoFactorToken,
      message: "Saisissez le code de votre application d'authentification."
    });
    return;
  }

  setRefreshTokenCookie(req, res, result.tokens.refreshToken);
  res.status(200).json({
    message: 'Connexion réussie',
    accessToken: result.tokens.accessToken,
    ...sessionProfile(result.user)
  });
};

/**
 * Déconnexion utilisateur
 * @route POST /api/auth/logout
 */
export const logout = async (req: Request, res: Response): Promise<void> => {
  await closeSession({
    accessToken: req.headers.authorization?.split(' ')[1],
    refreshToken: readRefreshTokenCookie(req)
  });

  clearRefreshTokenCookie(res);
  res.status(200).json({ message: 'Déconnexion réussie' });
};

/**
 * Rafraîchit l'access token à partir du refresh token du cookie
 * @route POST /api/auth/refresh-token
 */
export const refreshToken = async (req: Request, res: Response): Promise<void> => {
  const currentRefreshToken = readRefreshTokenCookie(req);
  if (!currentRefreshToken) {
    throw new HttpError(401, 'Aucune session à renouveler');
  }

  const renewal = await renewSession(currentRefreshToken);
  if ('failure' in renewal) {
    clearRefreshTokenCookie(res);
    throw new HttpError(401, renewal.failure);
  }

  setRefreshTokenCookie(req, res, renewal.refreshToken);
  res.status(200).json({ accessToken: renewal.accessToken });
};
