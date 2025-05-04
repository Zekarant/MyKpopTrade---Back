import { Request, Response } from 'express';
import { generateAccessToken, generateRefreshToken } from '../../../commons/services/tokenService';
import { IUser } from '../../../models/userModel';

/**
 * Gère la redirection après authentification sociale réussie
 * Mode par défaut basé sur NODE_ENV:
 * - development/test: mode API (JSON)
 * - production: redirection vers le frontend
 * Peut être forcé avec le paramètre responseMode=json|redirect
 */
export const oauthCallback = async (req: Request, res: Response): Promise<void> => {
  try {
    // L'utilisateur est déjà attaché à req.user par la stratégie Passport
    const user = req.user as IUser;
    
    // Déterminer le mode de réponse basé sur NODE_ENV, avec la possibilité de le forcer
    const isDevOrTest = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
    const defaultMode = isDevOrTest ? 'json' : 'redirect';
    const responseMode = req.query.responseMode ? 
      (req.query.responseMode === 'json' ? 'json' : 'redirect') : 
      defaultMode;
    
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
    
    if (responseMode === 'json') {
      // Mode API: retourner les informations en JSON (pour dev/test ou quand forcé)
      res.status(200).json({
        accessToken,
        refreshToken,
        user: {
          id: user._id,
          username: user.username,
          email: user.email,
          isEmailVerified: user.isEmailVerified,
          isPhoneVerified: user.isPhoneVerified
        }
      });
    } else {
      // Mode redirection: rediriger vers le frontend (pour production ou quand forcé)
      res.redirect(
        `${process.env.FRONTEND_URL}/auth/callback?` +
        `accessToken=${accessToken}&` +
        `refreshToken=${refreshToken}&` +
        `userId=${user._id}&` +
        `username=${encodeURIComponent(user.username)}`
      );
    }
  } catch (error) {
    // En cas d'erreur, utiliser la même logique pour le mode de réponse
    const isDevOrTest = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
    const defaultMode = isDevOrTest ? 'json' : 'redirect';
    const responseMode = req.query.responseMode ? 
      (req.query.responseMode === 'json' ? 'json' : 'redirect') : 
      defaultMode;
      
    console.error('Erreur lors de l\'authentification sociale:', error);
    
    if (responseMode === 'json') {
      res.status(500).json({ message: 'Erreur serveur lors de l\'authentification sociale' });
    } else {
      res.redirect(`${process.env.FRONTEND_URL}/login?error=server_error`);
    }
  }
};