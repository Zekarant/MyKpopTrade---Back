import { Request, Response, NextFunction } from 'express';

/** 180 jours : durée courante pour HSTS, sans preload. */
const HSTS_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;

/**
 * Une réponse d'API n'a rien à charger ni à exécuter : si l'une d'elles est
 * ouverte comme une page (JSON piégé, fichier mal typé), elle reste inerte.
 * Sans effet sur une image affichée par <img> depuis le front : la CSP d'une
 * ressource ne s'applique qu'au document qu'elle forme elle-même.
 */
const API_CONTENT_SECURITY_POLICY = "default-src 'none'; frame-ancestors 'none'";

/**
 * Fichiers déposés par les utilisateurs : `sandbox` les isole en plus dans une
 * origine opaque, sans script ni accès aux cookies de l'API.
 */
const UPLOADS_CONTENT_SECURITY_POLICY = `${API_CONTENT_SECURITY_POLICY}; sandbox`;

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
  res.setHeader(
    'Content-Security-Policy',
    req.path.startsWith('/uploads/') ? UPLOADS_CONTENT_SECURITY_POLICY : API_CONTENT_SECURITY_POLICY
  );
  if (req.secure) {
    res.setHeader('Strict-Transport-Security', `max-age=${HSTS_MAX_AGE_SECONDS}; includeSubDomains`);
  }
  next();
}
