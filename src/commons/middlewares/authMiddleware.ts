import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { tokenBlacklist } from '../services/tokenService';
import User from '../../models/userModel';
import logger from '../utils/logger';

// Interface pour le payload JWT
interface JwtPayload {
  id: string;
  role?: string;
  [key: string]: any;
}

// Extend Express Request interface
declare global {
  namespace Express {
    interface Request {
      userDetails?: any;
    }
  }
}

/**
 * Middleware pour vérifier et valider un token JWT
 */
export const authenticateJWT = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader) {
      res.status(401).json({ message: 'Accès non autorisé. Token manquant.' });
      return;
    }
    
    const token = authHeader.split(' ')[1];
    
    if (!token) {
      res.status(401).json({ message: 'Format du token invalide' });
      return;
    }
    
    // Vérifier si le token est dans la liste noire
    if (tokenBlacklist.has(token)) {
      res.status(401).json({ message: 'Token révoqué. Veuillez vous reconnecter.' });
      return;
    }
    
    try {
      // Décodage avec typage du payload
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'default_jwt_secret') as JwtPayload;
      
      // Vérifier que l'ID est présent
      if (!decoded.id) {
        res.status(401).json({ message: 'Token invalide: identifiant utilisateur manquant' });
        return;
      }
      
      // Extraire l'ID et les autres propriétés séparément pour éviter le problème d'écrasement
      const { id, ...otherProps } = decoded;
      req.user = { id, ...otherProps };
      
      next();
    } catch (tokenError) {
      // Gestion des erreurs spécifiques aux tokens
      if ((tokenError as Error).name === 'TokenExpiredError') {
        res.status(401).json({ 
          message: 'Token expiré',
          code: 'TOKEN_EXPIRED' // Code spécial pour le front-end
        });
      } else {
        res.status(401).json({ message: 'Token invalide' });
      }
    }
  } catch (error) {
    logger.error('Erreur lors de la vérification du token:', 
      error instanceof Error ? error.message : String(error)
    );
    res.status(500).json({ message: 'Erreur interne du serveur.' });
  }
};

/**
 * Middleware pour charger les détails complets de l'utilisateur
 * À utiliser après authenticateJWT
 */
export const loadUser = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = (req.user as any).id;
    
    if (!userId) {
      res.status(400).json({ message: 'ID utilisateur manquant' });
      return;
    }
    
    const user = await User.findById(userId);
    
    if (!user) {
      res.status(404).json({ message: 'Utilisateur non trouvé' });
      return;
    }
    
    if (user.accountStatus === 'deleted') {
      res.status(403).json({ message: 'Compte utilisateur supprimé' });
      return;
    }
    
    // Stocker l'utilisateur complet dans req.userDetails pour le distinguer du payload JWT
    req.userDetails = user;
    
    next();
  } catch (error) {
    logger.error('Erreur lors du chargement de l\'utilisateur:', 
      error instanceof Error ? error.message : String(error)
    );
    res.status(500).json({ message: 'Erreur interne du serveur.' });
  }
};

/**
 * Middleware pour vérifier si l'utilisateur est un administrateur
 * À utiliser après authenticateJWT
 */
export const requireAdmin = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {

    const userId = (req.user as any).id;
    // Vérifier que l'utilisateur est authentifié
    if (!userId) {
      res.status(401).json({ message: 'Authentification requise' });
      return;
    }
    
    // Récupérer l'utilisateur complet depuis la base de données pour vérifier son rôle
    const user = await User.findById(userId).select('role');
    
    if (!user) {
      res.status(404).json({ message: 'Utilisateur non trouvé' });
      return;
    }
    
    // Vérifier si l'utilisateur a le rôle d'administrateur
    if (user.role !== 'admin') {
      res.status(403).json({ 
        message: 'Accès non autorisé. Droits d\'administrateur requis.',
        code: 'ADMIN_REQUIRED'
      });
      return;
    }
    
    // L'utilisateur est un administrateur, continuer
    next();
  } catch (error) {
    logger.error('Erreur lors de la vérification des droits administrateur:', 
      error instanceof Error ? error.message : String(error)
    );
    res.status(500).json({ message: 'Erreur interne du serveur.' });
  }
};

/**
 * Middleware pour vérifier si l'utilisateur est un administrateur ou un modérateur
 * À utiliser après authenticateJWT
 */
export const requireStaff = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = (req.user as any).id;
    // Vérifier que l'utilisateur est authentifié
    if (!req.user || !userId) {
      res.status(401).json({ message: 'Authentification requise' });
      return;
    }
    
    // Récupérer l'utilisateur complet depuis la base de données pour vérifier son rôle
    const user = await User.findById(userId).select('role');
    
    if (!user) {
      res.status(404).json({ message: 'Utilisateur non trouvé' });
      return;
    }
    
    // Vérifier si l'utilisateur a un rôle d'administration ou de modération
    if (user.role !== 'admin' && user.role !== 'moderator') {
      res.status(403).json({ 
        message: 'Accès non autorisé. Droits de modération ou d\'administration requis.',
        code: 'STAFF_REQUIRED'
      });
      return;
    }
    
    // L'utilisateur fait partie du staff, continuer
    next();
  } catch (error) {
    logger.error('Erreur lors de la vérification des droits de staff:', 
      error instanceof Error ? error.message : String(error)
    );
    res.status(500).json({ message: 'Erreur interne du serveur.' });
  }
};