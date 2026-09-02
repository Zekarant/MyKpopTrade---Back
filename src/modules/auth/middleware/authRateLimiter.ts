import { Request, Response, NextFunction } from 'express';
import { RateLimiterMongo } from 'rate-limiter-flexible';
import mongoose from 'mongoose';
import logger from '../../../commons/utils/logger';

/**
 * Rate limiting des endpoints d'authentification, par adresse IP.
 *
 * Ces routes sont anonymes (pas encore de userId) : la clé est donc l'IP, ce qui
 * suppose `trust proxy` correctement configuré derrière un reverse proxy — sinon
 * toutes les requêtes partagent l'IP du proxy (cf. app.ts).
 *
 * Même stratégie de dégradation que le limiteur panier : une erreur technique
 * (Mongo pas encore connecté au démarrage) laisse passer la requête plutôt que
 * de rendre la connexion impossible.
 */

/** Fenêtres de limitation, en (tentatives, secondes). */
const LIMITS = {
  /** Anti brute-force / credential stuffing sur la connexion. */
  login: { points: 10, duration: 15 * 60 },
  /** Anti création massive de comptes. */
  register: { points: 5, duration: 60 * 60 },
  /** Anti « email bombing » : reset de mot de passe et renvoi de vérification. */
  emailDispatch: { points: 5, duration: 60 * 60 },
  /**
   * Anti « SMS bombing » : chaque envoi coûte réellement de l'argent chez Twilio
   * et harcèle le destinataire. Limité par utilisateur, pas par IP.
   */
  smsDispatch: { points: 3, duration: 60 * 60 },
  /**
   * Anti brute-force du code SMS. Le code fait 6 chiffres et vit 10 minutes :
   * sans plafond de tentatives, il est devinable en le forçant.
   */
  smsVerify: { points: 10, duration: 15 * 60 },
  /**
   * Anti brute-force du second facteur, avec son propre compteur.
   *
   * Volontairement distinct de `login` : partager le même compteur ferait qu'un
   * utilisateur se trompant plusieurs fois sur son code 2FA épuiserait aussi ses
   * tentatives de mot de passe, et se retrouverait bloqué sur les deux étapes.
   * Ce sont deux surfaces d'attaque différentes, chacune plafonnée.
   */
  twoFactorVerify: { points: 10, duration: 15 * 60 }
} as const;

type LimitName = keyof typeof LIMITS;

const instances = new Map<LimitName, RateLimiterMongo>();

function getLimiter(name: LimitName): RateLimiterMongo {
  let limiter = instances.get(name);
  if (!limiter) {
    limiter = new RateLimiterMongo({
      storeClient: mongoose.connection,
      keyPrefix: `auth_${name}_rate_limit`,
      points: LIMITS[name].points,
      duration: LIMITS[name].duration,
      tableName: 'rate_limits'
    });
    instances.set(name, limiter);
  }
  return limiter;
}

function createIpRateLimiter(name: LimitName, message: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const key = req.ip;
    if (!key) {
      next();
      return;
    }

    try {
      await getLimiter(name).consume(key);
      next();
    } catch (error: any) {
      // rate-limiter-flexible signale un dépassement via un RateLimiterRes, qui
      // porte `remainingPoints`. Toute autre erreur est technique.
      if (error && error.remainingPoints !== undefined) {
        const retryAfterSeconds = Math.ceil((error.msBeforeNext ?? 0) / 1000) || 60;
        logger.warn('Rate limit authentification dépassé', { limit: name, path: req.path });
        res.setHeader('Retry-After', String(retryAfterSeconds));
        res.status(429).json({
          success: false,
          message,
          retryAfterSeconds
        });
        return;
      }

      logger.error('Rate limiter authentification indisponible, requête laissée passer', {
        limit: name,
        error: error instanceof Error ? error.message : String(error)
      });
      next();
    }
  };
}

/**
 * Variante clée par utilisateur, pour les routes authentifiées : limiter par IP
 * y punirait tous les utilisateurs derrière une même sortie réseau.
 */
function createUserRateLimiter(name: LimitName, message: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const key = (req.user as any)?.id;
    if (!key) {
      next();
      return;
    }

    try {
      await getLimiter(name).consume(key);
      next();
    } catch (error: any) {
      if (error && error.remainingPoints !== undefined) {
        const retryAfterSeconds = Math.ceil((error.msBeforeNext ?? 0) / 1000) || 60;
        logger.warn('Rate limit utilisateur dépassé', { limit: name, path: req.path });
        res.setHeader('Retry-After', String(retryAfterSeconds));
        res.status(429).json({ success: false, message, retryAfterSeconds });
        return;
      }

      logger.error('Rate limiter indisponible, requête laissée passer', {
        limit: name,
        error: error instanceof Error ? error.message : String(error)
      });
      next();
    }
  };
}

export const rateLimitLogin = createIpRateLimiter(
  'login',
  'Trop de tentatives de connexion. Veuillez patienter quelques minutes avant de réessayer.'
);

export const rateLimitRegister = createIpRateLimiter(
  'register',
  'Trop de créations de compte depuis cette connexion. Veuillez réessayer plus tard.'
);

export const rateLimitEmailDispatch = createIpRateLimiter(
  'emailDispatch',
  "Trop de demandes d'envoi d'email. Veuillez patienter avant de réessayer."
);

export const rateLimitSmsDispatch = createUserRateLimiter(
  'smsDispatch',
  "Trop de demandes d'envoi de SMS. Veuillez patienter avant de réessayer."
);

export const rateLimitSmsVerify = createUserRateLimiter(
  'smsVerify',
  'Trop de tentatives de vérification. Veuillez demander un nouveau code.'
);

export const rateLimitTwoFactorVerify = createIpRateLimiter(
  'twoFactorVerify',
  'Trop de tentatives de vérification. Veuillez patienter quelques minutes avant de réessayer.'
);
