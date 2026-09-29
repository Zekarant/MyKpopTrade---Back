import multer from 'multer';
import { RequestHandler } from 'express';
import { stripMongoOperators } from './mongoOperatorMiddleware';

/**
 * multer, mais les champs texte sont nettoyés des clés `$…` : multer parse après
 * le nettoyage global d'app.ts et interprète la notation à crochets
 * (`username[$ne]=x` devient `{ username: { $ne: 'x' } }`).
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
