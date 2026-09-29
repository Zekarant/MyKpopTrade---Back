import twilio from 'twilio';
import crypto from 'crypto';
import env from '../../config/env';
import logger from '../utils/logger';

// Configuration Twilio
const accountSid = env.TWILIO_ACCOUNT_SID;
const authToken = env.TWILIO_AUTH_TOKEN;
const fromPhoneNumber = env.TWILIO_PHONE_NUMBER;
const smsEnabled = env.SMS_ENABLED;

// Client Twilio (seulement si la configuration est disponible)
const client = smsEnabled && accountSid && authToken ?
  twilio(accountSid, authToken) :
  null;

export class SmsUnavailableError extends Error {
  constructor() {
    super('L\'envoi de SMS est momentanément indisponible. Veuillez réessayer plus tard.');
    this.name = 'SmsUnavailableError';
  }
}

/**
 * Envoie un SMS de vérification via Twilio
 * @param phoneNumber Numéro de téléphone destinataire (E.164)
 * @param code Code de vérification à 6 chiffres
 */
export const sendVerificationSMS = async (phoneNumber: string, code: string): Promise<void> => {
  const message = `Votre code de vérification MyKpopTrade est : ${code}`;

  if (smsEnabled) {
    // Ne jamais renvoyer un « succès » sans SMS réellement parti.
    if (!client || !fromPhoneNumber) {
      throw new SmsUnavailableError();
    }
    try {
      await client.messages.create({
        body: message,
        from: fromPhoneNumber,
        to: phoneNumber
      });
    } catch (error) {
      logger.error('Échec de l\'envoi du SMS Twilio', {
        error: error instanceof Error ? error.message : String(error),
        phoneNumber
      });
      throw new Error('Impossible d\'envoyer le SMS. Veuillez réessayer plus tard.');
    }
    return;
  }

  // En production, ne jamais simuler : le code finirait lisible dans les logs.
  if (env.NODE_ENV === 'production') {
    throw new SmsUnavailableError();
  }

  // Hors production : code tracé pour tester le parcours sans Twilio.
  logger.warn('SMS désactivé — code de vérification non envoyé', {
    phoneNumber,
    simulatedCode: code
  });
};

/**
 * Génère un code de vérification à 6 chiffres.
 *
 * `crypto.randomInt` et non `Math.random()` : ce code est un facteur
 * d'authentification. `Math.random()` n'est pas cryptographiquement sûr — son
 * état interne est reconstituable à partir de quelques sorties observées, ce qui
 * rendait les codes suivants prédictibles (CWE-338).
 */
export const generateVerificationCode = (): string => {
  return crypto.randomInt(100000, 1000000).toString();
};

/** Condensat stocké en base à la place du code. */
export const hashVerificationCode = (code: string): string =>
  crypto.createHash('sha256').update(code).digest('hex');
