import { Request, Response, NextFunction } from 'express';

/** 180 jours : durée courante pour HSTS, sans preload. */
const HSTS_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;

/**
 * En-têtes de sécurité d'une API JSON.
 * Pas de helmet : son `Cross-Origin-Resource-Policy: same-origin` bloquerait les
 * images de /uploads côté front, et sa CSP par défaut casse l'affichage des PDF.
 * no-referrer : certaines URL portent encore un jeton (`?token=`).
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
