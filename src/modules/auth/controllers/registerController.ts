import { Request, Response } from 'express';
import { validateUsername, validateEmail, validatePassword } from '../../../commons/utils/validators';
import { HttpError } from '../../../commons/utils/httpError';
import { registerUser } from '../services/registrationService';
import { PASSWORD_RULES_MESSAGE, isNonEmptyString } from './validation';

/**
 * Inscription d'un nouvel utilisateur avec gestion des consentements RGPD
 * @route POST /api/auth/register
 */
export const register = async (req: Request, res: Response): Promise<void> => {
  const { username, email, password, confirmPassword, privacyPolicy, dataProcessing, marketing } = req.body;

  if (![username, email, password, confirmPassword].every(isNonEmptyString)) {
    throw new HttpError(400, 'Tous les champs sont obligatoires');
  }
  if (privacyPolicy !== true) {
    throw new HttpError(400, 'Vous devez accepter la politique de confidentialité pour vous inscrire');
  }
  if (dataProcessing !== true) {
    throw new HttpError(400, 'Vous devez accepter le traitement de vos données pour vous inscrire');
  }
  if (!validateUsername(username)) {
    throw new HttpError(400, 'Le nom d\'utilisateur doit contenir entre 3 et 30 caractères alphanumériques, underscore ou tiret');
  }
  if (!validateEmail(email)) {
    throw new HttpError(400, 'Format d\'email invalide');
  }
  if (password !== confirmPassword) {
    throw new HttpError(400, 'Les mots de passe ne correspondent pas');
  }
  if (!validatePassword(password)) {
    throw new HttpError(400, PASSWORD_RULES_MESSAGE);
  }

  const marketingConsent = marketing === true;
  const newUser = await registerUser({ username, email, password, marketingConsent });

  res.status(201).json({
    message: 'Inscription réussie ! Veuillez vérifier votre email pour activer votre compte.',
    userId: newUser._id,
    consentements: {
      privacyPolicy: true,
      dataProcessing: true,
      marketing: marketingConsent
    }
  });
};
