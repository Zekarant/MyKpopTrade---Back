import { Response } from 'express';
import { HttpError } from './httpError';

/**
 * Si `error` est une HttpError, renvoie la réponse correspondante et retourne la Response.
 * Sinon, retourne null — le caller doit enchaîner son fallback 500 habituel.
 *
 * Shape par défaut : `{ message }`. Pour les handlers qui utilisent d'autres shapes
 * (ex. `{ success: false, ... }` ou avec filler), gérer localement sans ce helper.
 */
export function mapHttpError(res: Response, error: unknown): Response | null {
  if (error instanceof HttpError) {
    return res.status(error.statusCode).json({ message: error.message });
  }
  return null;
}
