import { Request, Response } from 'express';
import { HttpError } from '../../../commons/utils/httpError';
import { setRefreshTokenCookie } from './refreshTokenCookie';
import { openSession, sessionProfile } from '../services/sessionService';
import {
  startTwoFactorActivation,
  confirmTwoFactorActivation,
  completeTwoFactorLogin,
  disableTwoFactor,
  regenerateRecoveryCodes,
  getTwoFactorStatus
} from '../services/twoFactorService';

const CODE_REQUIRED_MESSAGE = 'Le code de vérification est requis.';

/**
 * État de la double authentification.
 * @route GET /api/auth/2fa/status
 */
export const status = async (req: Request, res: Response): Promise<void> => {
  res.status(200).json(await getTwoFactorStatus(req.user!.id));
};

/**
 * Démarre l'activation : rend le QR code à scanner.
 * @route POST /api/auth/2fa/setup
 */
export const setup = async (req: Request, res: Response): Promise<void> => {
  const result = await startTwoFactorActivation(req.user!.id);
  res.status(200).json({ success: true, ...result });
};

/**
 * Confirme l'activation et rend les codes de secours (affichés une seule fois).
 * @route POST /api/auth/2fa/enable
 */
export const enable = async (req: Request, res: Response): Promise<void> => {
  const { code } = req.body;
  if (!code) {
    throw new HttpError(400, CODE_REQUIRED_MESSAGE);
  }

  const { recoveryCodes } = await confirmTwoFactorActivation(req.user!.id, String(code));

  res.status(200).json({
    success: true,
    message: 'Double authentification activée.',
    recoveryCodes,
    warning: 'Conservez ces codes en lieu sûr : ils ne seront plus affichés.'
  });
};

/**
 * Désactive la double authentification. Exige mot de passe ET code valide.
 * @route POST /api/auth/2fa/disable
 */
export const disable = async (req: Request, res: Response): Promise<void> => {
  const { password, code } = req.body;
  if (!password || !code) {
    throw new HttpError(400, 'Le mot de passe et un code de vérification sont requis.');
  }

  await disableTwoFactor(req.user!.id, String(password), String(code));
  res.status(200).json({ success: true, message: 'Double authentification désactivée.' });
};

/**
 * Régénère les codes de secours.
 * @route POST /api/auth/2fa/recovery-codes
 */
export const regenerate = async (req: Request, res: Response): Promise<void> => {
  const { code } = req.body;
  if (!code) {
    throw new HttpError(400, CODE_REQUIRED_MESSAGE);
  }

  const { recoveryCodes } = await regenerateRecoveryCodes(req.user!.id, String(code));

  res.status(200).json({
    success: true,
    recoveryCodes,
    warning: 'Vos anciens codes de secours ne sont plus valides.'
  });
};

/**
 * Deuxième étape de la connexion : échange le défi 2FA contre de vrais jetons.
 * @route POST /api/auth/2fa/verify
 * @access Public — protégé par le jeton de défi, non par une session
 */
export const verifyChallenge = async (req: Request, res: Response): Promise<void> => {
  const { twoFactorToken, code } = req.body;
  if (!twoFactorToken || !code) {
    throw new HttpError(400, 'Le jeton de vérification et le code sont requis.');
  }

  const { user, usedRecoveryCode, remainingRecoveryCodes } = await completeTwoFactorLogin(
    String(twoFactorToken),
    String(code)
  );
  const tokens = await openSession(user);

  setRefreshTokenCookie(req, res, tokens.refreshToken);
  res.status(200).json({
    message: 'Connexion réussie',
    accessToken: tokens.accessToken,
    usedRecoveryCode,
    remainingRecoveryCodes,
    ...sessionProfile(user)
  });
};
