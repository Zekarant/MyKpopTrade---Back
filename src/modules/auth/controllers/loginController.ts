import { Request, Response } from 'express';
import User from '../../../models/userModel';
import { 
  generateAccessToken, 
  generateRefreshToken,
  invalidateRefreshToken,
  verifyRefreshToken,
  tokenBlacklist 
} from '../../../commons/services/tokenService';

/**
 * Connexion utilisateur
 */
export const login = async (req: Request, res: Response): Promise<void> => {
  try {
    const { identifier, password } = req.body;
    
    if (!identifier || !password) {
      res.status(400).json({ message: 'Email/nom d\'utilisateur et mot de passe sont requis' });
      return;
    }

    const user = await User.findOne({
      $or: [
        { email: identifier },
        { username: identifier }
      ],
      accountStatus: { $ne: 'deleted' }
    });

    if (!user) {
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

    // Mise à jour de la dernière connexion
    user.lastLogin = new Date();
    await user.save();

    // Génération des tokens
    const accessToken = generateAccessToken(user);
    const refreshToken = await generateRefreshToken(user._id.toString());

    res.status(200).json({
      message: 'Connexion réussie',
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
  } catch (error) {
    console.error('Erreur lors de la connexion:', error);
    res.status(500).json({ message: 'Erreur lors de la connexion. Veuillez réessayer.' });
  }
};

/**
 * Déconnexion utilisateur
 */
export const logout = async (req: Request, res: Response): Promise<void> => {
  try {
    const { refreshToken } = req.body;

    // Ajouter le token d'accès à la liste noire
    const authHeader = req.headers.authorization;
    if (authHeader) {
      const accessToken = authHeader.split(' ')[1];
      if (accessToken) {
        tokenBlacklist.add(accessToken);
      }
    }

    // Invalider le refresh token
    if (refreshToken) {
      await invalidateRefreshToken(refreshToken);
    }

    res.status(200).json({ message: 'Déconnexion réussie' });
  } catch (error) {
    console.error('Erreur lors de la déconnexion:', error);
    res.status(500).json({ message: 'Erreur lors de la déconnexion' });
  }
};

/**
 * Rafraîchit l'access token en utilisant un refresh token
 */
export const refreshToken = async (req: Request, res: Response): Promise<void> => {
  try {
    const { refreshToken } = req.body;
    
    if (!refreshToken) {
      res.status(400).json({ message: 'Refresh token requis' });
      return;
    }
    
    const userId = await verifyRefreshToken(refreshToken);
    
    if (!userId) {
      res.status(401).json({ message: 'Refresh token invalide ou expiré' });
      return;
    }
    
    const user = await User.findById(userId);
    
    if (!user || user.accountStatus === 'deleted') {
      await invalidateRefreshToken(refreshToken);
      res.status(401).json({ message: 'Utilisateur non trouvé ou compte supprimé' });
      return;
    }
    
    // Génération d'un nouvel access token
    const newAccessToken = generateAccessToken(user);
    
    res.status(200).json({
      accessToken: newAccessToken,
      refreshToken: refreshToken // On renvoie le même refresh token
    });
  } catch (error) {
    console.error('Erreur lors du rafraîchissement du token:', error);
    res.status(500).json({ message: 'Erreur lors du rafraîchissement du token' });
  }
};