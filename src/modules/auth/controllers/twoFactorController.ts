import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import User from '../../../models/userModel';
import { asyncHandler } from '../../../commons/middlewares/errorMiddleware';
import { mapHttpError } from '../../../commons/utils/httpErrorMapper';
import logger from '../../../commons/utils/logger';
import env from '../../../config/env';
import {
  generateAccessToken,
  generateRefreshToken
} from '../../../commons/services/tokenService';
import {
  startTwoFactorActivation,
  confirmTwoFactorActivation,
  verifyTwoFactorCode,
  disableTwoFactor,
  regenerateRecoveryCodes,
  getTwoFactorStatus,
  TWO_FACTOR_TOKEN_PURPOSE
} from '../services/twoFactorService';

/** Identifiant de l'utilisateur authentifié. */
function currentUserId(req: Request): string {
  return (req.user as any).id;
}

/**
 * Renvoie la réponse d'une HttpError, ou un 500 générique en la journalisant.
 * `mapHttpError` ne gère que le premier cas ; ce wrapper évite de répéter le
 * fallback dans chaque handler.
 */
function respondWithError(res: Response, error: unknown, fallbackMessage: string): Response {
  const mapped = mapHttpError(res, error);
  if (mapped) return mapped;

  logger.error(fallbackMessage, {
    error: error instanceof Error ? error.message : String(error)
  });
  return res.status(500).json({ message: fallbackMessage });
}

/**
 * État de la double authentification.
 * @route GET /api/auth/2fa/status
 */
export const status = asyncHandler(async (req: Request, res: Response) => {
  try {
    return res.status(200).json(await getTwoFactorStatus(currentUserId(req)));
  } catch (error) {
    return respondWithError(res, error, 'Impossible de récupérer l\'état de la double authentification');
  }
});

/**
 * Démarre l'activation : rend le QR code à scanner.
 * @route POST /api/auth/2fa/setup
 */
export const setup = asyncHandler(async (req: Request, res: Response) => {
  try {
    const result = await startTwoFactorActivation(currentUserId(req));
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return respondWithError(res, error, 'Impossible de démarrer la configuration');
  }
});

/**
 * Confirme l'activation et rend les codes de secours (affichés une seule fois).
 * @route POST /api/auth/2fa/enable
 */
export const enable = asyncHandler(async (req: Request, res: Response) => {
  const { code } = req.body;

  if (!code) {
    return res.status(400).json({ message: 'Le code de vérification est requis.' });
  }

  try {
    const { recoveryCodes } = await confirmTwoFactorActivation(currentUserId(req), String(code));

    return res.status(200).json({
      success: true,
      message: 'Double authentification activée.',
      recoveryCodes,
      warning: 'Conservez ces codes en lieu sûr : ils ne seront plus affichés.'
    });
  } catch (error) {
    return respondWithError(res, error, 'Impossible d\'activer la double authentification');
  }
});

/**
 * Désactive la double authentification. Exige mot de passe ET code valide.
 * @route POST /api/auth/2fa/disable
 */
export const disable = asyncHandler(async (req: Request, res: Response) => {
  const { password, code } = req.body;

  if (!password || !code) {
    return res.status(400).json({
      message: 'Le mot de passe et un code de vérification sont requis.'
    });
  }

  try {
    await disableTwoFactor(currentUserId(req), String(password), String(code));
    return res.status(200).json({ success: true, message: 'Double authentification désactivée.' });
  } catch (error) {
    return respondWithError(res, error, 'Impossible de désactiver la double authentification');
  }
});

/**
 * Régénère les codes de secours.
 * @route POST /api/auth/2fa/recovery-codes
 */
export const regenerate = asyncHandler(async (req: Request, res: Response) => {
  const { code } = req.body;

  if (!code) {
    return res.status(400).json({ message: 'Le code de vérification est requis.' });
  }

  try {
    const { recoveryCodes } = await regenerateRecoveryCodes(currentUserId(req), String(code));

    return res.status(200).json({
      success: true,
      recoveryCodes,
      warning: 'Vos anciens codes de secours ne sont plus valides.'
    });
  } catch (error) {
    return respondWithError(res, error, 'Impossible de régénérer les codes de secours');
  }
});

/**
 * Deuxième étape de la connexion : échange le défi 2FA contre de vrais jetons.
 * @route POST /api/auth/2fa/verify
 * @access Public — protégé par le jeton de défi, non par une session
 */
export const verifyChallenge = asyncHandler(async (req: Request, res: Response) => {
  const { twoFactorToken, code } = req.body;

  if (!twoFactorToken || !code) {
    return res.status(400).json({ message: 'Le jeton de vérification et le code sont requis.' });
  }

  let userId: string;
  try {
    const decoded = jwt.verify(String(twoFactorToken), env.JWT_SECRET) as {
      userId?: string;
      purpose?: string;
    };

    // Un jeton d'accès normal ne doit pas pouvoir servir ici : on exige le
    // `purpose` du défi 2FA.
    if (decoded.purpose !== TWO_FACTOR_TOKEN_PURPOSE || !decoded.userId) {
      return res.status(401).json({ message: 'Jeton de vérification invalide.' });
    }

    userId = decoded.userId;
  } catch (error) {
    const expired = (error as Error).name === 'TokenExpiredError';
    return res.status(401).json({
      message: expired
        ? 'La vérification a expiré. Reconnectez-vous.'
        : 'Jeton de vérification invalide.',
      code: expired ? 'TWO_FACTOR_CHALLENGE_EXPIRED' : 'TWO_FACTOR_CHALLENGE_INVALID'
    });
  }

  try {
    const { usedRecoveryCode, remainingRecoveryCodes } = await verifyTwoFactorCode(
      userId,
      String(code)
    );

    const user = await User.findById(userId);
    if (!user) {
      return res.status(401).json({ message: 'Utilisateur introuvable.' });
    }

    if (user.accountStatus === 'suspended') {
      return res.status(403).json({
        message: 'Votre compte est suspendu. Contactez le support.',
        code: 'ACCOUNT_SUSPENDED'
      });
    }

    user.lastLogin = new Date();
    await user.save();

    const accessToken = generateAccessToken(user);
    const refreshToken = await generateRefreshToken(user._id.toString());

    logger.info('Connexion réussie après double authentification', {
      userId: user._id.toString().substring(0, 5) + '...',
      usedRecoveryCode
    });

    return res.status(200).json({
      message: 'Connexion réussie',
      accessToken,
      refreshToken,
      usedRecoveryCode,
      remainingRecoveryCodes,
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
    });
  } catch (error) {
    return respondWithError(res, error, 'Vérification impossible');
  }
});
