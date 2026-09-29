import { Request, Response, NextFunction } from 'express';

/**
 * Supprime récursivement les clés commençant par `$` : aucun formulaire légitime
 * n'en envoie, elles ne servent qu'à glisser un opérateur Mongo dans un filtre.
 */
export function stripMongoOperators(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(stripMongoOperators);
    return;
  }
  if (value === null || typeof value !== 'object') return;

  for (const key of Object.keys(value)) {
    if (key.startsWith('$')) {
      delete (value as Record<string, unknown>)[key];
    } else {
      stripMongoOperators((value as Record<string, unknown>)[key]);
    }
  }
}

/**
 * Protège contre l'injection d'opérateurs NoSQL via le corps JSON/urlencoded.
 * `req.query` n'est pas concerné : le parser "simple" d'Express 5 ne produit que
 * des chaînes. Les corps multipart sont nettoyés par `sanitizedMulter`.
 */
export const stripMongoOperatorsFromBody =(req: Request, _res: Response, next: NextFunction): void => {
  stripMongoOperators(req.body);
  next();
};
