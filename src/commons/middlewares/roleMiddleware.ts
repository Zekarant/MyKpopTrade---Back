import { Request, Response, NextFunction } from 'express';

/**
 * Middleware pour vérifier si l'utilisateur a un rôle spécifique
 * @param roles Liste des rôles autorisés
 */
export const checkRole = (roles: string[]) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    // L'utilisateur est déjà authentifié par le middleware JWT
    const user = (req as any).user;
    
    if (!user) {
      res.status(401).json({
        error: {
          message: 'Vous devez être connecté pour accéder à cette ressource',
          code: 'UNAUTHORIZED'
        }
      });
      return;
    }

    // Vérifier si le rôle de l'utilisateur est dans la liste des rôles autorisés
    if (!roles.includes(user.role)) {
      res.status(403).json({
        error: {
          message: 'Vous n\'avez pas les droits nécessaires pour accéder à cette ressource',
          code: 'FORBIDDEN'
        }
      });
      return;
    }

    next();
  };
};

// Raccourcis pour les rôles courants
export const requireAdmin = checkRole(['admin']);
export const requireModerator = checkRole(['admin', 'moderator']);