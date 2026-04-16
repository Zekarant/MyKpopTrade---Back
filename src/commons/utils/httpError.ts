/**
 * Erreur métier avec code HTTP attendu. Les contrôleurs la mappent
 * directement sur res.status(err.statusCode).json({ message: err.message }).
 */
export class HttpError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}
