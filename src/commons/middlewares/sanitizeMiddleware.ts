import { Request, Response, NextFunction } from 'express';
import DOMPurify from 'isomorphic-dompurify';

/**
 * Retire le HTML actif des champs texte de premier niveau du corps JSON.
 *
 * Les paramètres d'URL ne sont pas concernés : sous Express 5, `req.query` est
 * recalculé à chaque lecture, et la version précédente, qui les réécrivait,
 * n'avait donc aucun effet. Les activer maintenant modifierait des recherches
 * légitimes (« a<b »), alors qu'aucun paramètre n'est renvoyé en HTML : l'API
 * répond en JSON et le front échappe à l'affichage.
 *
 * Monté par `router.use`, ce middleware passe avant multer : les corps
 * multipart (messages avec pièces jointes) ne sont pas encore parsés ici.
 */
export const sanitizeInputs = (req: Request, _res: Response, next: NextFunction): void => {
  if (req.body && typeof req.body === 'object') {
    for (const key of Object.keys(req.body)) {
      if (typeof req.body[key] === 'string') {
        req.body[key] = DOMPurify.sanitize(req.body[key]);
      }
    }
  }
  next();
};
