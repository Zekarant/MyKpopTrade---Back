import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import User from '../../../models/userModel';
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
import logger from '../../../commons/utils/logger';
import {
  isTwoFactorEnabled,
  issueTwoFactorChallengeToken
} from '../services/twoFactorService';
import {
  setRefreshTokenCookie,
  clearRefreshTokenCookie,
  readRefreshTokenCookie
} from '../services/refreshTokenCookie';

/**
 * Empreinte bcrypt (même coût que les vrais mots de passe) comparée quand le
 * compte n'existe pas : la réponse prend alors le même temps, et ne révèle pas
 * quels identifiants ont un compte.
 */
const DUMMY_PASSWORD_HASH = '$2b$10$v.0iX5kb.g6SF.4uGSbCiO.QZLrO5BcDOwfIoEU7nfxBJurfArh0q';

/**
 * Connexion utilisateur
 */
export const login = async (req: Request, res: Response): Promise<void> => {
  try {
    const { identifier, password } = req.body;

    // Chaînes uniquement : un tableau deviendrait un `$in` dans la requête Mongo.
    if (typeof identifier !== 'string' || typeof password !== 'string' || !identifier || !password) {
      res.status(400).json({ message: 'Email/nom d\'utilisateur et mot de passe sont requis' });
      return;
    }

    // Ajouter .select('+password') pour inclure explicitement le champ password
    const user = await User.findOne({
      $or: [
        { email: identifier },
        { username: identifier }
      ],
      accountStatus: { $ne: 'deleted' }
    }).select('+password');

    if (!user) {
      await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
      res.status(401).json({ message: 'Identifiants incorrects' });
      return;
    }

    const isPasswordValid = await user.comparePassword(password);
    if (!isPasswordValid) {
      res.status(401).json({ message: 'Identifiants incorrects' });
      return;
    }

    if (!user.isEmailVerified) {
      res.status(403).json({ message: 'Veuillez vérifier votre adresse email avant de vous connecter' });
      return;
    }

    if (user.accountStatus === 'suspended') {
      res.status(403).json({
        message: 'Votre compte est suspendu. Contactez le support.',
        code: 'ACCOUNT_SUSPENDED'
      });
      return;
    }

    // Double authentification active : le mot de passe seul ne suffit pas.
    // Aucun jeton d'accès n'est délivré ici ; on rend un jeton de défi
    // à courte durée de vie, utilisable uniquement sur /auth/2fa/verify.
    if (isTwoFactorEnabled(user)) {
      const twoFactorToken = issueTwoFactorChallengeToken(user._id.toString());

      logger.info('Défi de double authentification émis', {
        userId: user._id.toString().substring(0, 5) + '...'
      });

      res.status(200).json({
        requiresTwoFactor: true,
        twoFactorToken,
        message: "Saisissez le code de votre application d'authentification."
      });
      return;
    }

    // Mise à jour de la dernière connexion
    user.lastLogin = new Date();
    await user.save();

    // Génération des tokens
    const accessToken = generateAccessToken(user);
    setRefreshTokenCookie(req, res, await generateRefreshToken(user._id.toString()));

    // Journalisation de la connexion réussie (sans données sensibles)
    logger.info('Connexion réussie', {
      userId: user._id.toString().substring(0, 5) + '...',
      username: user.username
    });

    res.status(200).json({
      message: 'Connexion réussie',
      accessToken,
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
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Erreur lors de la connexion', { error: errorMessage });
    res.status(500).json({ message: 'Erreur lors de la connexion. Veuillez réessayer.' });
  }
};

function isValidAccessToken(token: string): boolean {
  try {
    jwt.verify(token, env.JWT_SECRET, JWT_VERIFY_OPTIONS);
    return true;
  } catch {
    return false;
  }
}

/**
 * Déconnexion utilisateur
 */
export const logout = async (req: Request, res: Response): Promise<void> => {
  try {
    const refreshToken = readRefreshTokenCookie(req);

    // La route n'exige pas de session (un jeton d'accès expiré ne doit pas
    // bloquer la déconnexion) : seul un jeton authentique et valide est révoqué.
    const accessToken = req.headers.authorization?.split(' ')[1];
    if (accessToken && isValidAccessToken(accessToken)) {
      await revokeAccessToken(accessToken);
    }

    if (refreshToken) {
      await invalidateRefreshToken(refreshToken);
    }

    clearRefreshTokenCookie(res);
    res.status(200).json({ message: 'Déconnexion réussie' });
  } catch (error) {
    logger.error('Erreur lors de la déconnexion', {
      error: error instanceof Error ? error.message : String(error)
    });
    res.status(500).json({ message: 'Erreur lors de la déconnexion' });
  }
};

/**
 * Rafraîchit l'access token en utilisant un refresh token
 */
export const refreshToken = async (req: Request, res: Response): Promise<void> => {
  try {
    const refreshToken = readRefreshTokenCookie(req);

    if (!refreshToken) {
      res.status(401).json({ message: 'Aucune session à renouveler' });
      return;
    }

    // Le jeton présenté est consommé : le cookie reçoit celui qui le remplace.
    const rotated = await rotateRefreshToken(refreshToken);

    if (!rotated) {
      clearRefreshTokenCookie(res);
      res.status(401).json({ message: 'Refresh token invalide ou expiré' });
      return;
    }

    const user = await User.findById(rotated.userId);

    if (!user || user.accountStatus === 'deleted') {
      await invalidateAllUserRefreshTokens(rotated.userId);
      clearRefreshTokenCookie(res);
      res.status(401).json({ message: 'Utilisateur non trouvé ou compte supprimé' });
      return;
    }

    setRefreshTokenCookie(req, res, rotated.refreshToken);
    res.status(200).json({ accessToken: generateAccessToken(user) });
  } catch (error) {
    logger.error('Erreur lors du rafraîchissement du token', {
      error: error instanceof Error ? error.message : String(error)
    });
    res.status(500).json({ message: 'Erreur lors du rafraîchissement du token' });
  }
};