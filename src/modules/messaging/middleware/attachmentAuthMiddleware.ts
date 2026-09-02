import { Request, Response, NextFunction } from 'express';

/**
 * Autorise le jeton d'accès à arriver en query param, UNIQUEMENT pour les
 * pièces jointes.
 *
 * Une balise `<img src>` ou `<a href>` ne peut pas porter d'en-tête
 * `Authorization` : sans cette passerelle, la route authentifiée des pièces
 * jointes répond 401 à tout affichage d'image, et le front se rabattait sur le
 * dossier statique public — ce qui contournait le contrôle d'appartenance à la
 * conversation.
 *
 * Le compromis est assumé et volontairement circonscrit : un jeton en URL peut
 * fuir (journaux d'accès, en-tête Referer, historique du navigateur). C'est
 * pourquoi ce middleware n'est monté que sur cette route, et non ajouté à
 * `authenticateJWT`, qui protège tout le reste de l'API. La durée de vie courte
 * du jeton d'accès (15 minutes) borne l'exposition.
 *
 * Toute la validation reste faite par `authenticateJWT` en aval : ce middleware
 * ne fait que déplacer le jeton, il n'en vérifie rien.
 */
export const allowAttachmentTokenInQuery = (
  req: Request,
  _res: Response,
  next: NextFunction
): void => {
  if (!req.headers.authorization && typeof req.query.token === 'string' && req.query.token) {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }

  next();
};
