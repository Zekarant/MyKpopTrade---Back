import { Request, Response, NextFunction } from 'express';

/**
 * Supprime récursivement les clés commençant par `$` d'un objet.
 * Aucun formulaire légitime n'envoie de telles clés ; elles ne servent qu'à
 * glisser un opérateur Mongo (`{"$ne": null}`, `{"$regex": "^a"}`) dans un
 * champ que le code utilise ensuite comme valeur de filtre.
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
 * `req.query` n'est pas concerné : le parser "simple" d'Express 5 ne produit
 * que des chaînes ou tableaux de chaînes. Les corps multipart (multer) sont
 * parsés plus tard, dans les routes, et ne passent pas par ici.
 */
export const stripMongoOperatorsFromBody =(req: Request, _res: Response, next: NextFunction): void => {
  stripMongoOperators(req.body);
  next();
};
