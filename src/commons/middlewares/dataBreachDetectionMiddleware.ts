import { Request, Response, NextFunction } from 'express';
import { GdprLogger } from '../utils/gdprLogger';

/**
 * Middleware de détection des violations de données potentielles
 */
export const dataBreachDetection = (resourceType: string) => {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req.user as any).id;
      
      // Ne rien faire si pas d'utilisateur authentifié
      if (!userId) {
        return next();
      }
      
      // Récupérer l'adresse IP, en tenant compte des proxys
      const ip = req.headers['x-forwarded-for'] || 
                req.connection.remoteAddress || 
                req.socket.remoteAddress || 
                'unknown';
      
      // Utiliser le GdprLogger existant pour vérifier les activités suspectes
      const isSuspicious = GdprLogger.checkSuspiciousActivity(
        userId, 
        resourceType, 
        typeof ip === 'string' ? ip : Array.isArray(ip) ? ip[0] : 'unknown'
      );
      
      // Si activité suspecte, ralentir les requêtes mais ne pas bloquer
      if (isSuspicious) {
        // Ajouter un délai artificiel pour ralentir les attaques potentielles
        setTimeout(() => {
          next();
        }, 2000); // 2 secondes de délai
      } else {
        next();
      }
    } catch (error) {
      // En cas d'erreur, continuer normalement pour ne pas bloquer l'application
      GdprLogger.logError('Erreur dans le middleware de détection de violation', error);
      next();
    }
  };
};