import User, { hashOneTimeToken } from '../../../models/userModel';
import { sendPasswordResetEmail } from '../../../commons/services/emailService';
import { HttpError, notFound } from '../../../commons/utils/httpError';
import logger from '../../../commons/utils/logger';
import {
  invalidateAllUserRefreshTokens,
  invalidateOtherUserRefreshTokens
} from '../../../commons/services/tokenService';

/**
 * Envoie un lien de réinitialisation si un compte porte cet email. Ne dit pas
 * s'il en existe un : l'appelant répond pareil dans les deux cas.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const user = await User.findOne({ email });
  if (!user) return;

  const resetToken = user.generatePasswordResetToken();
  await user.save();
  await sendPasswordResetEmail(user, resetToken);

  logger.info('Demande de réinitialisation de mot de passe', { userId: user._id });
}

/**
 * Remplace le mot de passe du compte auquel le jeton (reçu par email) a été émis.
 * @throws HttpError 400 si le jeton est inconnu ou expiré
 */
export async function resetPasswordWithToken(token: string, newPassword: string): Promise<void> {
  const user = await User.findOne({
    passwordResetToken: hashOneTimeToken(token),
    passwordResetExpires: { $gt: Date.now() },
    accountStatus: { $ne: 'deleted' }
  });

  if (!user) {
    throw new HttpError(400, 'Token de réinitialisation invalide ou expiré', 'INVALID_RESET_TOKEN');
  }

  user.password = newPassword;
  user.passwordResetToken = undefined;
  user.passwordResetExpires = undefined;
  await user.save();

  // Une réinitialisation sert souvent après une compromission : les sessions
  // ouvertes avec l'ancien mot de passe ne doivent plus pouvoir se rafraîchir.
  await invalidateAllUserRefreshTokens(user._id.toString());

  logger.info('Mot de passe réinitialisé avec succès', { userId: user._id });
}

/**
 * Ré-authentifie l'utilisateur avant une action sensible (changement d'email,
 * anonymisation). Un compte créé par OAuth n'a pas de mot de passe connu : il
 * en définit un via « mot de passe oublié ».
 */
export async function verifyCurrentPassword(userId: string, currentPassword: unknown): Promise<void> {
  if (typeof currentPassword !== 'string' || !currentPassword) {
    throw new HttpError(400, 'Mot de passe actuel requis', 'CURRENT_PASSWORD_REQUIRED');
  }
  const userWithPassword = await User.findById(userId).select('+password');
  // `comparePassword` lève sur un compte sans mot de passe : on répond 401, pas 500.
  if (!userWithPassword?.password || !(await userWithPassword.comparePassword(currentPassword))) {
    throw new HttpError(401, 'Mot de passe actuel incorrect', 'CURRENT_PASSWORD_INVALID');
  }
}

/**
 * Change le mot de passe de l'utilisateur connecté.
 *
 * @param keptRefreshToken session à l'origine du changement, la seule qui reste ouverte
 * @throws HttpError 401 mot de passe actuel incorrect, 400 nouveau mot de passe identique
 */
export async function changePassword({
  userId,
  currentPassword,
  newPassword,
  keptRefreshToken
}: {
  userId: string;
  currentPassword: string;
  newPassword: string;
  keptRefreshToken?: string;
}): Promise<void> {
  const user = await User.findById(userId).select('+password');
  if (!user) {
    throw notFound('Utilisateur non trouvé', 'USER_NOT_FOUND');
  }

  if (!(await user.comparePassword(currentPassword))) {
    throw new HttpError(401, 'Mot de passe actuel incorrect', 'CURRENT_PASSWORD_INVALID');
  }

  if (await user.comparePassword(newPassword)) {
    throw new HttpError(400, 'Le nouveau mot de passe doit être différent de l\'ancien', 'PASSWORD_UNCHANGED');
  }

  user.password = newPassword;
  user.lastLoginAt = new Date();
  await user.save();

  // Changer de mot de passe doit déconnecter un éventuel intrus : les autres
  // sessions ne peuvent plus se rafraîchir, seule celle qui a fait le changement reste.
  await invalidateOtherUserRefreshTokens(userId, keptRefreshToken);

  logger.info('Mot de passe mis à jour avec succès', { userId });
}
