/**
 * Erreur attendue (donnée invalide, ressource absente, droit refusé…), avec son
 * statut HTTP. Les contrôleurs et services la lèvent ; le gestionnaire d'erreurs
 * central (errorMiddleware) en fait la réponse `{ message, code?, ...details }`.
 */
export class HttpError extends Error {
  /** Champs ajoutés tels quels au corps de la réponse (ex. `approvalUrl`, `errors`). */
  details?: Record<string, unknown>;

  constructor(public statusCode: number, message: string, public code?: string, details?: Record<string, unknown>) {
    super(message);
    this.details = details;
  }
}

/** 404 avec un message lisible : la ressource n'existe pas ou n'est pas visible. */
export const notFound = (message = 'Ressource introuvable', code = 'NOT_FOUND') => new HttpError(404, message, code);

/** 400 pour une entrée client invalide. */
export const badRequest = (message: string, code = 'BAD_REQUEST', details?: Record<string, unknown>) =>
  new HttpError(400, message, code, details);

/** 403 : authentifié, mais pas autorisé pour cette action. */
export const forbidden = (message = 'Action non autorisée', code = 'FORBIDDEN') => new HttpError(403, message, code);

/**
 * 403 sauf si `ownerId` (ObjectId ou chaîne) désigne `userId` : l'objet est bien
 * le sien. Une seule écriture du contrôle, quelle que soit la forme de l'identifiant.
 */
export function assertOwner(ownerId: { toString(): string }, userId: string, message?: string, code?: string): void {
  if (ownerId.toString() !== userId) throw forbidden(message, code);
}
