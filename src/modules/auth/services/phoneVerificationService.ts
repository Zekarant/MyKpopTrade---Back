import crypto from 'crypto';
import User from '../../../models/userModel';
import {
  sendVerificationSMS,
  generateVerificationCode,
  hashVerificationCode,
  SmsUnavailableError
} from '../../../commons/services/smsService';
import { normalizePhoneNumber } from '../../../commons/utils/validators';
import { HttpError, userNotFound } from '../../../commons/utils/httpError';
import logger from '../../../commons/utils/logger';

const CODE_VALIDITY_MS = 10 * 60 * 1000;
/** Essais ratés tolérés sur un même code avant de l'invalider. */
const MAX_CODE_ATTEMPTS = 5;

const phoneAlreadyUsedError = () =>
  new HttpError(409, 'Ce numéro est déjà vérifié sur un autre compte', 'PHONE_ALREADY_USED');


/**
 * Compare le condensat attendu et celui du code fourni à temps constant.
 *
 * `!==` s'arrête au premier caractère différent : le temps de réponse fuit la
 * longueur du préfixe correct. Les deux condensats SHA-256 font toujours la
 * même longueur, ce que timingSafeEqual exige.
 */
function isVerificationCodeEqual(expectedHash: string, provided: string): boolean {
  const expectedBuffer = Buffer.from(expectedHash, 'hex');
  const providedBuffer = Buffer.from(hashVerificationCode(provided.trim()), 'hex');
  if (expectedBuffer.length !== providedBuffer.length) return false;

  return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

/** Un numéro vérifié ne sert qu'à un seul compte (anti multi-comptes). */
async function isPhoneVerifiedByAnotherUser(phoneNumber: string, userId: string): Promise<boolean> {
  return Boolean(await User.exists({ phoneNumber, isPhoneVerified: true, _id: { $ne: userId } }));
}

/**
 * Envoie un code de vérification par SMS. Le numéro fourni (facultatif)
 * remplace celui du profil, dont la vérification est alors réinitialisée.
 *
 * @throws HttpError 400 numéro absent ou invalide, 409 numéro vérifié sur un
 *   autre compte, 503 envoi de SMS indisponible
 */
export async function sendPhoneVerificationCode(userId: string, requestedPhoneNumber?: unknown): Promise<void> {
  const user = await User.findById(userId);
  if (!user) throw userNotFound();

  const rawPhoneNumber = requestedPhoneNumber || user.phoneNumber;
  if (!rawPhoneNumber) {
    throw new HttpError(400, 'Numéro de téléphone requis');
  }

  const phoneNumber = normalizePhoneNumber(rawPhoneNumber);
  if (!phoneNumber) {
    throw new HttpError(400, 'Format de numéro de téléphone invalide', 'INVALID_PHONE_NUMBER');
  }

  // Vérifié avant l'envoi : chaque SMS est facturé.
  if (await isPhoneVerifiedByAnotherUser(phoneNumber, userId)) {
    throw phoneAlreadyUsedError();
  }

  if (user.phoneNumber !== phoneNumber) {
    user.phoneNumber = phoneNumber;
    user.isPhoneVerified = false;
  }

  // Seul le condensat est stocké ; un nouveau code remet les essais à zéro.
  const verificationCode = generateVerificationCode();
  user.phoneVerificationCode = hashVerificationCode(verificationCode);
  user.phoneVerificationExpires = new Date(Date.now() + CODE_VALIDITY_MS);
  user.phoneVerificationAttempts = 0;
  await user.save();

  try {
    await sendVerificationSMS(phoneNumber, verificationCode);
  } catch (error) {
    if (error instanceof SmsUnavailableError) {
      logger.error('Envoi de SMS demandé alors que Twilio n\'est pas configuré');
      throw new HttpError(503, error.message, 'SMS_UNAVAILABLE');
    }
    throw error;
  }

  logger.info('Code de vérification téléphone envoyé', {
    userId: user._id,
    phoneNumber: phoneNumber.replace(/\d(?=\d{4})/g, '*')
  });
}

/**
 * Vérifie le code SMS reçu et marque le téléphone comme vérifié.
 *
 * @throws HttpError 400 code absent, expiré, incorrect ou trop d'essais,
 *   409 numéro vérifié entre-temps sur un autre compte
 */
export async function confirmPhoneVerificationCode(userId: string, code: string): Promise<void> {
  const user = await User.findById(userId).select('+phoneVerificationCode +phoneVerificationAttempts');
  if (!user) throw userNotFound();

  if (!user.phoneVerificationCode || !user.phoneVerificationExpires) {
    throw new HttpError(400, 'Aucun code de vérification n\'a été demandé', 'NO_PHONE_CODE_REQUESTED');
  }

  if (user.phoneVerificationExpires < new Date()) {
    throw new HttpError(400, 'Le code de vérification a expiré, veuillez en demander un nouveau', 'PHONE_CODE_EXPIRED');
  }

  if (!isVerificationCodeEqual(user.phoneVerificationCode, code)) {
    const attempts = (user.phoneVerificationAttempts ?? 0) + 1;
    if (attempts >= MAX_CODE_ATTEMPTS) {
      user.phoneVerificationCode = undefined;
      user.phoneVerificationExpires = undefined;
      user.phoneVerificationAttempts = undefined;
      await user.save();
      throw new HttpError(400, 'Trop de tentatives : demandez un nouveau code', 'PHONE_CODE_ATTEMPTS_EXCEEDED');
    }
    user.phoneVerificationAttempts = attempts;
    await user.save();
    throw new HttpError(400, 'Code de vérification incorrect', 'PHONE_CODE_INVALID');
  }

  // Deux comptes ont pu demander un code pour le même numéro : seul le
  // premier à le valider le garde.
  if (user.phoneNumber && await isPhoneVerifiedByAnotherUser(user.phoneNumber, userId)) {
    throw phoneAlreadyUsedError();
  }

  user.isPhoneVerified = true;
  user.phoneVerificationCode = undefined;
  user.phoneVerificationExpires = undefined;
  user.phoneVerificationAttempts = undefined;
  await user.save();

  logger.info('Numéro de téléphone vérifié avec succès', { userId });
}
