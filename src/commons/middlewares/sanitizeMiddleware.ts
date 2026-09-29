import { Request, Response, NextFunction } from 'express';
import DOMPurify from 'isomorphic-dompurify';

/**
 * Retire le HTML actif des champs texte de premier niveau du corps JSON.
 * `req.query` n'est pas traité : Express 5 le recalcule à chaque lecture, et
 * aucun paramètre n'est renvoyé en HTML. Monté avant multer, il ne voit pas
 * les corps multipart.
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
