import crypto from 'crypto';
import { Request } from 'express';
import { readCookie } from '../commons/utils/cookies';

/** Cookie qui lie un parcours OAuth au navigateur qui l'a lancé. */
export const OAUTH_STATE_COOKIE = 'oauth_state';

const COOKIE_PATH = '/api/auth';

/** Délai laissé pour consentir chez le fournisseur. */
const STATE_TTL_MS = 10 * 60 * 1000;

/** Données applicatives transportées dans le `state` (liaison de compte). */
export interface OAuthAppState {
  linkToken?: string;
}

interface EncodedState extends OAuthAppState {
  nonce: string;
}

/**
 * Décode le `state` renvoyé par le fournisseur, sans le vérifier : passport
 * exécute `CookieStateStore.verify` avant d'accepter le code d'autorisation.
 */
export function readOAuthState(raw: unknown): EncodedState | null {
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof parsed?.nonce !== 'string') return null;
    return {
      nonce: parsed.nonce,
      linkToken: typeof parsed.linkToken === 'string' ? parsed.linkToken : undefined
    };
  } catch {
    return null;
  }
}

function sameNonce(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

type StoreCallback = (error: Error | null, state?: string) => void;
type VerifyCallback = (error: Error | null, ok: boolean, state?: OAuthAppState | { message: string }) => void;

/**
 * Magasin de `state` OAuth sans session serveur : le nonce part dans le `state`
 * et dans un cookie HttpOnly `SameSite=Lax` à usage unique, qui doivent
 * correspondre au retour (empêche la CSRF de connexion ou de liaison de compte).
 *
 * passport-oauth2 n'utilise ce magasin que si l'option `state` n'est PAS une
 * chaîne : les routes passent donc un objet (`{ linkToken }`) ou rien.
 */
export class CookieStateStore {
  // Les arités (4 et 3) sont celles qu'attend passport-oauth2.
  store(req: Request, appState: OAuthAppState | undefined, _meta: unknown, callback: StoreCallback): void {
    const nonce = crypto.randomBytes(16).toString('base64url');
    req.res!.cookie(OAUTH_STATE_COOKIE, nonce, {
      httpOnly: true,
      secure: req.secure,
      sameSite: 'lax',
      path: COOKIE_PATH,
      maxAge: STATE_TTL_MS
    });
    const encoded: EncodedState = { nonce, ...appState };
    callback(null, Buffer.from(JSON.stringify(encoded)).toString('base64url'));
  }

  verify(req: Request, providedState: unknown, callback: VerifyCallback): void {
    const expected = readCookie(req, OAUTH_STATE_COOKIE);
    req.res!.clearCookie(OAUTH_STATE_COOKIE, { path: COOKIE_PATH });

    const state = readOAuthState(providedState);
    if (!state || !expected || !sameNonce(state.nonce, expected)) {
      callback(null, false, { message: 'oauth_state_invalid' });
      return;
    }
    callback(null, true, { linkToken: state.linkToken });
  }
}
