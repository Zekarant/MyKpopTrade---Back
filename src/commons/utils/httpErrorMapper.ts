import { Response } from 'express';
import mongoose from 'mongoose';
import { HttpError } from './httpError';

const DUPLICATE_KEY_ERROR = 11000;

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === DUPLICATE_KEY_ERROR;
}

/**
 * Erreur métier ou erreur de données client (validation Mongoose, valeur
 * invalide, doublon) traduite en HttpError ; null pour une vraie erreur serveur.
 */
export function asHttpError(error: unknown): HttpError | null {
  if (error instanceof HttpError) return error;
  if (error instanceof mongoose.Error.ValidationError) {
    return new HttpError(400, `Données invalides : ${Object.keys(error.errors).join(', ')}`, 'VALIDATION_ERROR');
  }
  if (error instanceof mongoose.Error.CastError) {
    return new HttpError(400, `Valeur invalide pour ${error.path}`, 'INVALID_VALUE');
  }
  if (isDuplicateKeyError(error)) {
    return new HttpError(409, 'Cet élément existe déjà', 'DUPLICATE');
  }
  return null;
}

/**
 * Si `error` est une HttpError (ou une erreur de données client, cf. asHttpError),
 * renvoie la réponse correspondante et retourne la Response.
 * Sinon, retourne null — le caller doit enchaîner son fallback 500 habituel.
 *
 * Shape par défaut : `{ message, code? }` — le code permet au front de distinguer
 * un refus métier (ex. BLOCKED) sans analyser le message. Pour les handlers qui
 * utilisent d'autres shapes (ex. `{ success: false, ... }`), gérer localement.
 */
export function mapHttpError(res: Response, error: unknown): Response | null {
  const httpError = asHttpError(error);
  if (httpError) {
    return res.status(httpError.statusCode).json({
      message: httpError.message,
      ...(httpError.code ? { code: httpError.code } : {})
    });
  }
  return null;
}
