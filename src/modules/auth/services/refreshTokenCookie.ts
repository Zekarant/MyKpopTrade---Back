import { Request, Response } from 'express';
import { readCookie } from '../../../commons/utils/cookies';
import { SESSION_LIFETIME_MS } from '../../../commons/services/tokenService';

/**
 * Le refresh token (7 jours) ne transite que dans un cookie HttpOnly : une XSS
 * côté front ne peut ni le lire ni l'exfiltrer, alors qu'il était auparavant
 * rendu dans le JSON et stocké par le front dans un cookie lisible en JS.
 *
 * Nom distinct de l'ancien cookie du front (`refreshToken`) : en développement,
 * front et API partagent l'hôte `localhost`, donc le même pot de cookies.
 */
const REFRESH_TOKEN_COOKIE = 'mkt_refresh';

/** Seules les routes /api/auth (refresh, logout) en ont besoin. */
const COOKIE_PATH = '/api/auth';

/**
 * `Lax` suffit : refresh et logout sont des POST, que `Lax` n'envoie jamais
 * depuis un autre site. `secure` suit le protocole (TRUST_PROXY derrière un
 * proxy TLS) pour rester utilisable sur http://localhost.
 */
export function setRefreshTokenCookie(req: Request, res: Response, refreshToken: string): void {
  res.cookie(REFRESH_TOKEN_COOKIE, refreshToken, {
    httpOnly: true,
    secure: req.secure,
    sameSite: 'lax',
    path: COOKIE_PATH,
    maxAge: SESSION_LIFETIME_MS
  });
}

export function clearRefreshTokenCookie(res: Response): void {
  res.clearCookie(REFRESH_TOKEN_COOKIE, { path: COOKIE_PATH });
}

export function readRefreshTokenCookie(req: Request): string | undefined {
  return readCookie(req, REFRESH_TOKEN_COOKIE) || undefined;
}
