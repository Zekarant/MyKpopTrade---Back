import { Request, Response } from 'express';
import { HttpError } from '../../../commons/utils/httpError';
import { verifyEmailToken, resendVerificationEmail } from '../services/emailVerificationService';
import { isNonEmptyString } from './validation';

/**
 * Vérification de l'email avec le token
 * @route GET /api/auth/verify-email/:token
 */
export const verifyEmail = async (req: Request, res: Response): Promise<void> => {
  await verifyEmailToken(String(req.params.token));
  res.status(200).json({ message: 'Email vérifié avec succès. Vous pouvez maintenant vous connecter.' });
};

/**
 * Renvoi d'un email de vérification
 * @route POST /api/auth/resend-verification
 */
export const resendVerification = async (req: Request, res: Response): Promise<void> => {
  const { email } = req.body;

  if (!isNonEmptyString(email)) {
    throw new HttpError(400, 'Email requis');
  }

  await resendVerificationEmail(email);

  // Même réponse dans tous les cas : elle ne doit pas révéler si l'adresse a un
  // compte, ni s'il est déjà vérifié.
  res.status(200).json({
    message: 'Si cette adresse correspond à un compte non vérifié, un nouveau lien de vérification vient d\'être envoyé.'
  });
};
