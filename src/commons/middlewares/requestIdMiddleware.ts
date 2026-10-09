import { randomUUID } from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { runWithRequestId } from '../utils/requestContext';

export const REQUEST_ID_HEADER = 'X-Request-Id';

/**
 * Identifiant accepté depuis l'amont (reverse proxy, front) : caractères sûrs
 * et longueur bornée. Une valeur libre finirait telle quelle dans chaque ligne
 * de log (injection de faux logs, lignes géantes).
 */
const VALID_REQUEST_ID = /^[\w.:-]{1,128}$/;

/**
 * Corrèle toutes les lignes de log d'une même requête : reprend l'identifiant
 * transmis par l'amont s'il est valide, sinon en génère un, le renvoie au
 * client et le rend disponible au logger pour toute la durée de la requête.
 */
export const requestIdMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  const incomingId = req.get(REQUEST_ID_HEADER);
  const requestId = incomingId && VALID_REQUEST_ID.test(incomingId) ? incomingId : randomUUID();

  res.setHeader(REQUEST_ID_HEADER, requestId);
  runWithRequestId(requestId, next);
};
