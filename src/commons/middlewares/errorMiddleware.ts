import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger';
import { asHttpError } from '../utils/httpErrorMapper';
import env from '../../config/env';
import { REQUEST_ID_HEADER } from './requestIdMiddleware';

/**
 * Format unique des réponses d'erreur de l'API :
 *
 *   { message, code?, ...details, requestId? }
 *
 * - `message` : texte destiné à l'utilisateur (le front l'affiche tel quel) ;
 * - `code` : identifiant stable qui permet au front de distinguer un refus
 *   métier (BLOCKED, ORDER_NOT_APPROVED…) sans analyser le message ;
 * - `details` d'une HttpError : champs ajoutés tels quels (ex. `approvalUrl`,
 *   `errors` d'une validation champ par champ) ;
 * - `requestId` : sur les 5xx seulement, pour retrouver les logs de la requête.
 *
 * Les contrôleurs ne construisent plus ce corps eux-mêmes : ils lèvent une
 * HttpError (erreur attendue) ou laissent remonter l'exception (bug). Express 5
 * transmet ici les promesses rejetées des handlers asynchrones.
 */
export interface ApiErrorBody {
  message: string;
  code?: string;
  requestId?: string;
  [detail: string]: unknown;
}

const INTERNAL_ERROR_MESSAGE = 'Une erreur interne est survenue. Veuillez réessayer plus tard.';

export const errorHandler = (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
  const httpError = asHttpError(err);
  const statusCode = httpError?.statusCode ?? 500;
  const isServerError = statusCode >= 500;

  if (isServerError) {
    // Le body passe par le sanitizer du logger (cf. logger.ts).
    logger.error(`[${req.method}] ${req.path} - ${statusCode}`, {
      error: err instanceof Error ? err.stack : String(err),
      body: req.body,
      params: req.params,
      query: req.query,
      user: req.user?.id || 'non authentifié'
    });
  } else {
    // Refus attendu (validation, droits…) : pas une erreur à traiter.
    logger.info(`[${req.method}] ${req.path} - ${statusCode} ${httpError?.code ?? ''}`.trim());
  }

  // Les 5xx sont des bugs : leur message peut contenir des détails
  // d'infrastructure (requêtes Mongo, chemins, champs internes) qu'on ne
  // divulgue pas en production.
  const rawMessage = httpError?.message || (err instanceof Error ? err.message : '') || INTERNAL_ERROR_MESSAGE;
  const message = isServerError && env.NODE_ENV === 'production' ? INTERNAL_ERROR_MESSAGE : rawMessage;

  const body: ApiErrorBody = {
    ...(httpError?.details ?? {}),
    message,
    code: httpError?.code ?? (isServerError ? 'INTERNAL_SERVER_ERROR' : undefined),
    ...(isServerError && { requestId: res.get(REQUEST_ID_HEADER) })
  };
  if (body.code === undefined) delete body.code;

  res.status(statusCode).json(body);
};

/**
 * Middleware pour gérer les routes non trouvées
 */
export const notFoundHandler = (req: Request, res: Response): void => {
  logger.warn(`Route non trouvée: [${req.method}] ${req.path}`);

  res.status(404).json({ message: 'Route non trouvée', code: 'NOT_FOUND' } satisfies ApiErrorBody);
};

/**
 * @deprecated Express 5 transmet déjà au gestionnaire d'erreurs les promesses
 * rejetées des handlers : ce wrapper est inutile. Retiré au fil des modules.
 */
// Signature de méthode : ses paramètres sont bivariants, ce qui laisse passer un
// contrôleur typé avec une requête plus précise (ex. AuthenticatedRequest).
type RouteHandler = { bivarianceHack(req: Request, res: Response, next: NextFunction): unknown }['bivarianceHack'];

export const asyncHandler = (fn: RouteHandler) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};
