import mongoose from 'mongoose';
import { RateLimiterMongo } from 'rate-limiter-flexible';
import { HttpError } from '../../../commons/utils/httpError';
import logger from '../../../commons/utils/logger';

/**
 * Plafond de vérifications de code 2FA par compte, toutes adresses IP
 * confondues. La limite par IP de /2fa/verify ne suffit pas : avec le mot de
 * passe et quelques centaines d'IP, un code à 6 chiffres se force en quelques
 * heures. Le compteur est partagé par la connexion, la désactivation et la
 * régénération des codes de secours.
 */
const MAX_ATTEMPTS = 10;
const WINDOW_SECONDS = 15 * 60;

let limiter: RateLimiterMongo | undefined;

function getLimiter(): RateLimiterMongo {
  limiter ??= new RateLimiterMongo({
    storeClient: mongoose.connection,
    keyPrefix: 'auth_two_factor_account_rate_limit',
    points: MAX_ATTEMPTS,
    duration: WINDOW_SECONDS,
    tableName: 'rate_limits'
  });
  return limiter;
}

/**
 * Compte une tentative de vérification pour ce compte.
 * @throws HttpError 429 une fois le plafond atteint.
 */
export async function consumeTwoFactorAttempt(userId: string): Promise<void> {
  try {
    await getLimiter().consume(userId);
  } catch (error: any) {
    // Un dépassement arrive sous forme de RateLimiterRes (`remainingPoints`).
    if (error && error.remainingPoints !== undefined) {
      logger.warn('Plafond de vérifications 2FA atteint pour un compte', {
        userId: userId.substring(0, 5) + '...'
      });
      throw new HttpError(
        429,
        'Trop de codes erronés pour ce compte. Patientez quelques minutes avant de réessayer.'
      );
    }
    // Une panne technique du limiteur ne doit pas empêcher toute connexion.
    logger.error('Limiteur 2FA par compte indisponible, tentative laissée passer', {
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
