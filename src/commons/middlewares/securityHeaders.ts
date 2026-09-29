import { Request, Response, NextFunction } from 'express';

/** 180 jours : durée courante pour HSTS, sans preload. */
const HSTS_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;

/**
 * En-têtes de sécurité d'une API JSON.
 *
 * Pas de helmet : sa politique `Cross-Origin-Resource-Policy: same-origin`
 * empêcherait le front (autre origine) d'afficher les images de /uploads, et
 * sa CSP par défaut casse l'affichage des PDF joints aux messages. Les en-têtes
 * ci-dessous sont ceux qui servent réellement ici :
 * - nosniff : un fichier n'est jamais interprété autrement que son type ;
 * - frame DENY : aucune réponse de l'API n'a à être encadrée (clickjacking) ;
 * - no-referrer : certaines URL portent encore un jeton (`?token=`), qui ne
 *   doit pas fuiter vers le site suivant ;
 * - HSTS, uniquement sur une requête HTTPS (le navigateur l'ignore sinon).
 */
export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.secure) {
    res.setHeader('Strict-Transport-Security', `max-age=${HSTS_MAX_AGE_SECONDS}; includeSubDomains`);
  }
  next();
}
