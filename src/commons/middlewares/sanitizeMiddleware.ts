import { Request, Response, NextFunction } from 'express';
import { toPlainText } from '../utils/plainText';

/**
 * Ramène les champs texte de premier niveau du corps JSON à du texte brut
 * (balises et contenu actif retirés, entités décodées : voir plainText).
 * `req.query` n'est pas traité : Express 5 le recalcule à chaque lecture, et
 * aucun paramètre n'est renvoyé en HTML. Monté avant multer, il ne voit pas
 * les corps multipart.
 */
export const sanitizeInputs = (req: Request, _res: Response, next: NextFunction): void => {
  if (req.body && typeof req.body === 'object') {
    for (const key of Object.keys(req.body)) {
      if (typeof req.body[key] === 'string') {
        req.body[key] = toPlainText(req.body[key]);
      }
    }
  }
  next();
};
