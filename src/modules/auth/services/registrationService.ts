import User from '../../../models/userModel';
import { sendVerificationEmail } from '../../../commons/services/emailService';
import { HttpError } from '../../../commons/utils/httpError';
import logger from '../../../commons/utils/logger';
import { maskUserId } from './authCommon';

export interface RegistrationInput {
  username: string;
  email: string;
  password: string;
  /** Consentement facultatif ; politique de confidentialité et traitement des données sont exigés en amont. */
  marketingConsent: boolean;
}

/**
 * Crée un compte avec ses consentements RGPD horodatés et envoie l'email de
 * vérification. Les champs sont supposés déjà validés (format, consentements).
 *
 * @throws HttpError 409 si l'email ou le nom d'utilisateur est déjà pris
 */
export async function registerUser({ username, email, password, marketingConsent }: RegistrationInput) {
  const existingUser = await User.findOne({ $or: [{ email }, { username }] }).select('email').lean();

  if (existingUser) {
    throw existingUser.email === email
      ? new HttpError(409, 'Cet email est déjà utilisé', 'EMAIL_ALREADY_USED')
      : new HttpError(409, 'Ce nom d\'utilisateur est déjà utilisé', 'USERNAME_ALREADY_USED');
  }

  const now = new Date();
  const newUser = new User({
    username,
    email,
    password,
    privacyPolicyAccepted: true,
    privacyPolicyAcceptedAt: now,
    dataProcessingConsent: true,
    dataProcessingConsentAt: now,
    marketingConsent,
    marketingConsentAt: marketingConsent ? now : undefined,
    lastLoginAt: now
  });

  const verificationToken = newUser.generateVerificationToken();
  await newUser.save();

  await sendVerificationEmail(newUser, verificationToken);

  logger.info('Nouvel utilisateur inscrit avec consentements RGPD', {
    userId: maskUserId(newUser._id.toString()),
    privacyAccepted: true,
    dataProcessingAccepted: true,
    marketingAccepted: marketingConsent
  });

  return newUser;
}
