import multer from 'multer';
import { RequestHandler } from 'express';
import { stripMongoOperators } from './mongoOperatorMiddleware';

/**
 * multer, mais les champs texte du formulaire sont nettoyés des clés `$…`.
 *
 * multer parse le corps multipart dans la route, donc après le nettoyage
 * global d'app.ts, et il interprète la notation à crochets :
 * `username[$ne]=x` devient `{ username: { $ne: 'x' } }`. Seules les méthodes
 * utilisées par l'API sont exposées : une nouvelle route ne peut pas
 * contourner le nettoyage en appelant multer directement sans s'en apercevoir.
 */
export function sanitizedMulter(options: multer.Options) {
  const instance = multer(options);

  const thenStrip = (parse: RequestHandler): RequestHandler => (req, res, next) =>
    parse(req, res, (error?: unknown) => {
      if (!error) stripMongoOperators(req.body);
      next(error);
    });

  return {
    single: (fieldName: string) => thenStrip(instance.single(fieldName)),
    array: (fieldName: string, maxCount?: number) => thenStrip(instance.array(fieldName, maxCount))
  };
}
