import { Request, Response } from 'express';
import { validatePassword } from '../../../commons/utils/validators';
import { HttpError } from '../../../commons/utils/httpError';
import { requestPasswordReset, resetPasswordWithToken, changePassword } from '../services/passwordService';
import { readRefreshTokenCookie } from './refreshTokenCookie';
import { PASSWORD_RULES_MESSAGE, isNonEmptyString } from './validation';

const FORGOT_PASSWORD_RESPONSE =
  'Si cet email est associé à un compte, un lien de réinitialisation a été envoyé.';

/**
 * Demande de réinitialisation de mot de passe
 * @route POST /api/auth/forgot-password
 */
export const forgotPassword = async (req: Request, res: Response): Promise<void> => {
  const { email } = req.body;

  if (!isNonEmptyString(email)) {
    throw new HttpError(400, 'Email requis');
  }

  await requestPasswordReset(email);

  // Même réponse que l'email soit connu ou non : sinon la route révèle quels
  // emails ont un compte.
  res.status(200).json({ message: FORGOT_PASSWORD_RESPONSE });
};

/**
 * Réinitialisation du mot de passe avec token
 * @route POST /api/auth/reset-password/:token
 */
export const resetPassword = async (req: Request, res: Response): Promise<void> => {
  const { password, confirmPassword } = req.body;

  if (!isNonEmptyString(password) || !isNonEmptyString(confirmPassword)) {
    throw new HttpError(400, 'Les champs mot de passe et confirmation sont requis');
  }
  if (password !== confirmPassword) {
    throw new HttpError(400, 'Les mots de passe ne correspondent pas');
  }
  if (!validatePassword(password)) {
    throw new HttpError(400, PASSWORD_RULES_MESSAGE);
  }

  await resetPasswordWithToken(String(req.params.token), password);

  res.status(200).json({
    message: 'Mot de passe réinitialisé avec succès. Vous pouvez maintenant vous connecter.'
  });
};

/**
 * Mise à jour du mot de passe de l'utilisateur connecté
 * @route PUT /api/auth/update-password
 */
export const updatePassword = async (req: Request, res: Response): Promise<void> => {
  const { currentPassword, newPassword, confirmPassword } = req.body;

  if (![currentPassword, newPassword, confirmPassword].every(isNonEmptyString)) {
    throw new HttpError(400, 'Tous les champs sont obligatoires');
  }
  if (newPassword !== confirmPassword) {
    throw new HttpError(400, 'Les nouveaux mots de passe ne correspondent pas');
  }
  if (!validatePassword(newPassword)) {
    throw new HttpError(400, PASSWORD_RULES_MESSAGE);
  }

  await changePassword({
    userId: req.user!.id,
    currentPassword,
    newPassword,
    keptRefreshToken: readRefreshTokenCookie(req)
  });

  res.status(200).json({ message: 'Mot de passe mis à jour avec succès' });
};
