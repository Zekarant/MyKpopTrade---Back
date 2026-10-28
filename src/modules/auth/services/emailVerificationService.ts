import User, { hashOneTimeToken } from '../../../models/userModel';
import { sendVerificationEmail } from '../../../commons/services/emailService';
import { HttpError } from '../../../commons/utils/httpError';
import logger from '../../../commons/utils/logger';

/**
 * Valide l'adresse email du compte auquel le jeton (reçu par email) a été émis.
 * @throws HttpError 400 si le jeton est inconnu ou expiré
 */
export async function verifyEmailToken(token: string): Promise<void> {
  const user = await User.findOne({
    emailVerificationToken: hashOneTimeToken(token),
    emailVerificationExpires: { $gt: Date.now() },
    accountStatus: { $ne: 'deleted' }
  });

  if (!user) {
    throw new HttpError(400, 'Token de vérification invalide ou expiré', 'INVALID_VERIFICATION_TOKEN');
  }

  user.isEmailVerified = true;
  user.emailVerificationToken = undefined;
  user.emailVerificationExpires = undefined;
  await user.save();
}

/**
 * Renvoie un lien de vérification aux seuls comptes non vérifiés. Ne signale
 * rien à l'appelant : la réponse ne doit pas révéler si l'adresse a un compte.
 */
export async function resendVerificationEmail(email: string): Promise<void> {
  const user = await User.findOne({ email });
  if (!user || user.isEmailVerified) return;

  const verificationToken = user.generateVerificationToken();
  await user.save();
  // Envoi non attendu : ni sa durée ni son échec ne doivent distinguer la
  // réponse de celle d'une adresse inconnue.
  sendVerificationEmail(user, verificationToken).catch((error) => {
    logger.error('Échec du renvoi de l\'email de vérification', {
      error: error instanceof Error ? error.message : String(error)
    });
  });
}
