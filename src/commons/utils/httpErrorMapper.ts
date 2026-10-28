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
  const clientStatus = exposedClientStatus(error);
  if (clientStatus) {
    return new HttpError(clientStatus, (error as Error).message, CLIENT_ERROR_CODES[clientStatus] ?? 'BAD_REQUEST');
  }
  return null;
}

const CLIENT_ERROR_CODES: Record<number, string> = {
  400: 'BAD_REQUEST',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE'
};

/**
 * Statut 4xx d'une erreur au format http-errors (body-parser : JSON malformé,
 * corps trop volumineux…), qui porte `status`/`statusCode` et `expose: true`.
 */
function exposedClientStatus(error: unknown): number | null {
  if (!(error instanceof Error)) return null;
  const { status, statusCode, expose } = error as Error & { status?: unknown; statusCode?: unknown; expose?: unknown };
  const code = typeof statusCode === 'number' ? statusCode : status;
  return expose === true && typeof code === 'number' && code >= 400 && code < 500 ? code : null;
}
