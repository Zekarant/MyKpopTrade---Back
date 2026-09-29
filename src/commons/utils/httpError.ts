/**
 * Erreur métier avec code HTTP attendu. Les contrôleurs la mappent
 * directement sur res.status(err.statusCode).json({ message: err.message, code? }).
 */
export class HttpError extends Error {
  /** Champs ajoutés tels quels au corps de la réponse. */
  details?: Record<string, unknown>;

  constructor(public statusCode: number, message: string, public code?: string) {
    super(message);
  }
}
