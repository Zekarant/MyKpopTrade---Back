import { Request, Response } from 'express';
import { generateAccessToken, generateRefreshToken } from '../../../commons/services/tokenService';
import User, { IUser } from '../../../models/userModel';
import { isTwoFactorEnabled, issueTwoFactorChallengeToken } from '../services/twoFactorService';
import { issueOneTimeCode, consumeOneTimeCode } from '../services/oneTimeCodeService';
import logger from '../../../commons/utils/logger';

/**
 * Gère la redirection après authentification sociale réussie.
 * Par défaut : redirection vers le frontend (le flow OAuth est lancé depuis
 * le navigateur). Le mode JSON reste disponible via `?responseMode=json`
 * pour les tests.
 */
export const oauthCallback = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = req.user as IUser | undefined;

    const responseMode = req.query.responseMode === 'json' ? 'json' : 'redirect';
    
    if (!user) {
      if (responseMode === 'json') {
        res.status(401).json({ message: 'Authentification échouée' });
      } else {
        res.redirect(`${process.env.FRONTEND_URL}/login?error=auth_failed`);
      }
      return;
    }

    // 2FA active : l'OAuth remplace le mot de passe, pas le second facteur.
    // Même défi que /auth/login ; le front ouvre l'étape 2FA de /login.
    if (isTwoFactorEnabled(user)) {
      const twoFactorToken = issueTwoFactorChallengeToken(String(user._id));
      if (responseMode === 'json') {
        res.status(200).json({ requiresTwoFactor: true, twoFactorToken });
      } else {
        const params = new URLSearchParams({ twoFactorToken });
        res.redirect(`${process.env.FRONTEND_URL}/login?${params.toString()}`);
      }
      return;
    }

    const userId = String(user._id);
    const isNewUser = (req as Request & { isNewUser?: boolean }).isNewUser === true;

    const requiresProfileCompletion = user.profileCompleted === false;

    if (responseMode === 'json') {
      const accessToken = generateAccessToken(user);
      const refreshToken = await generateRefreshToken(userId);
      res.status(200).json({
        accessToken,
        refreshToken,
        isNewUser,
        requiresProfileCompletion,
        user: {
          id: user._id,
          username: user.username,
          email: user.email,
          isEmailVerified: user.isEmailVerified,
          isPhoneVerified: user.isPhoneVerified,
          profileCompleted: user.profileCompleted !== false
        }
      });
    } else {
      // Les jetons ne passent pas dans l'URL (historique du navigateur,
      // journaux du serveur du front) : le front échange ce code sur
      // POST /api/auth/oauth/exchange.
      const params = new URLSearchParams({ code: await issueOneTimeCode(userId, 'oauth_login') });
      if (isNewUser) params.set('newAccount', '1');
      if (requiresProfileCompletion) params.set('completeProfile', '1');
      res.redirect(`${process.env.FRONTEND_URL}/auth/callback?${params.toString()}`);
    }
  } catch (error) {
    console.error('Erreur lors de l\'authentification sociale:', error);

    if (req.query.responseMode === 'json') {
      res.status(500).json({ message: 'Erreur serveur lors de l\'authentification sociale' });
    } else {
      res.redirect(`${process.env.FRONTEND_URL}/login?error=server_error`);
    }
  }
};

/**
 * Échange le code de fin de connexion OAuth contre les jetons de session.
 * @route POST /api/auth/oauth/exchange
 * @access Public — protégé par le code, à usage unique et valable une minute
 */
export const exchangeOAuthCode = async (req: Request, res: Response): Promise<void> => {
  const { code } = req.body;
  if (typeof code !== 'string' || !code) {
    res.status(400).json({ message: 'Code de connexion requis.' });
    return;
  }

  try {
    const userId = await consumeOneTimeCode(code, 'oauth_login');
    const user = userId ? await User.findById(userId) : null;
    if (!user || user.accountStatus === 'deleted') {
      res.status(401).json({ message: 'Connexion expirée. Recommencez.', code: 'OAUTH_CODE_INVALID' });
      return;
    }
    if (user.accountStatus === 'suspended') {
      res.status(403).json({ message: 'Votre compte est suspendu. Contactez le support.', code: 'ACCOUNT_SUSPENDED' });
      return;
    }

    res.status(200).json({
      accessToken: generateAccessToken(user),
      refreshToken: await generateRefreshToken(String(user._id)),
      user: { id: user._id, username: user.username }
    });
  } catch (error) {
    logger.error('Échange du code de connexion OAuth impossible', {
      error: error instanceof Error ? error.message : String(error)
    });
    res.status(500).json({ message: 'Erreur serveur pendant la connexion.' });
  }
};