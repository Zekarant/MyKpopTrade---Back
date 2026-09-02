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
      
      // `req.ip` résolu par Express selon le réglage `trust proxy` (cf. app.ts).
      // On lisait auparavant l'en-tête X-Forwarded-For brut : le client la
      // contrôle, il suffisait donc de la faire varier à chaque requête pour
      // rendre le comptage par IP inopérant.
      const ip = req.ip || 'unknown';

      const isSuspicious = GdprLogger.checkSuspiciousActivity(userId, resourceType, ip);
      
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