import { Request, Response } from 'express';
import { HttpError } from '../../../commons/utils/httpError';
import { sendPhoneVerificationCode, confirmPhoneVerificationCode } from '../services/phoneVerificationService';

/**
 * Envoie un code de vérification par SMS au numéro fourni, ou à celui du profil.
 * @route POST /api/auth/send-phone-verification
 */
export const sendVerificationCode = async (req: Request, res: Response): Promise<void> => {
  await sendPhoneVerificationCode(req.user!.id, req.body?.phoneNumber);
  res.status(200).json({ message: 'Un code de vérification a été envoyé par SMS' });
};

/**
 * Vérifie le code SMS reçu et marque le téléphone comme vérifié
 * @route POST /api/auth/verify-phone
 */
export const verifyPhoneNumber = async (req: Request, res: Response): Promise<void> => {
  const { code } = req.body;

  if (typeof code !== 'string' || !code) {
    throw new HttpError(400, 'Code de vérification requis');
  }

  await confirmPhoneVerificationCode(req.user!.id, code);

  res.status(200).json({
    message: 'Numéro de téléphone vérifié avec succès',
    isPhoneVerified: true
  });
};
