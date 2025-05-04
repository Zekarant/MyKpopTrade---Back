import { Request, Response, NextFunction } from 'express';
import DOMPurify from 'isomorphic-dompurify';

/**
 * Sanitize les données d'entrée pour prévenir les attaques XSS
 */
export const sanitizeInputs = (req: Request, _res: Response, next: NextFunction): void => {
  try {
    if (req.body && typeof req.body === 'object') {
      // Sanitize chaque champ texte du corps de la requête
      Object.keys(req.body).forEach((key) => {
        if (typeof req.body[key] === 'string') {
          req.body[key] = DOMPurify.sanitize(req.body[key]);
        }
      });
    }
    
    // Sanitize les paramètres de requête
    if (req.query && typeof req.query === 'object') {
      Object.keys(req.query).forEach((key) => {
        if (typeof req.query[key] === 'string') {
          req.query[key] = DOMPurify.sanitize(req.query[key] as string);
        }
      });
    }
    
    next();
  } catch (error) {
    next();
  }
};