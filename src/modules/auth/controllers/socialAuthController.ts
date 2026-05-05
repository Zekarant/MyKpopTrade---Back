import { Request, Response } from 'express';
import { generateAccessToken, generateRefreshToken } from '../../../commons/services/tokenService';
import { IUser } from '../../../models/userModel';

/**
 * Gère la redirection après authentification sociale réussie.
 * Par défaut : redirection vers le frontend (le flow OAuth est lancé depuis
 * le navigateur). Le mode JSON reste disponible via `?responseMode=json`
 * pour les tests.
 */
export const oauthCallback = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = req.user as IUser;

    const responseMode = req.query.responseMode === 'json' ? 'json' : 'redirect';
    
    if (!user) {
      if (responseMode === 'json') {
        res.status(401).json({ message: 'Authentification échouée' });
      } else {
        res.redirect(`${process.env.FRONTEND_URL}/login?error=auth_failed`);
      }
      return;
    }

    // Génération des tokens
    const accessToken = generateAccessToken(user);
    // Assurez-vous que _id existe et est du bon type
    const userId = user._id as string | { toString(): string };
    const refreshToken = await generateRefreshToken(userId.toString());
    
    const isNewUser = (req as Request & { isNewUser?: boolean }).isNewUser === true;

    const requiresProfileCompletion = user.profileCompleted === false;

    if (responseMode === 'json') {
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
      const params = new URLSearchParams({
        accessToken,
        refreshToken,
        userId: String(user._id),
        username: user.username,
      });
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