import { Request, Response } from 'express';
import crypto from 'crypto';
import User from '../../../models/userModel';
import {
  sendVerificationSMS,
  generateVerificationCode,
  hashVerificationCode,
  SmsUnavailableError
} from '../../../commons/services/smsService';
import { normalizePhoneNumber } from '../../../commons/utils/validators';
import logger from '../../../commons/utils/logger';

const CODE_VALIDITY_MS = 10 * 60 * 1000;
/** Essais ratés tolérés sur un même code avant de l'invalider. */
const MAX_CODE_ATTEMPTS = 5;

/**
 * Compare le condensat attendu et celui du code fourni à temps constant.
 *
 * `!==` s'arrête au premier caractère différent : le temps de réponse fuit la
 * longueur du préfixe correct. Les deux condensats SHA-256 font toujours la
 * même longueur, ce que timingSafeEqual exige.
 */
function isVerificationCodeEqual(expectedHash: string, provided: unknown): boolean {
  if (typeof provided !== 'string') return false;

  const expectedBuffer = Buffer.from(expectedHash, 'hex');
  const providedBuffer = Buffer.from(hashVerificationCode(provided.trim()), 'hex');
  if (expectedBuffer.length !== providedBuffer.length) return false;

  return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

/** Un numéro vérifié ne sert qu'à un seul compte (anti multi-comptes). */
async function isPhoneVerifiedByAnotherUser(phoneNumber: string, userId: string): Promise<boolean> {
  return Boolean(await User.exists({ phoneNumber, isPhoneVerified: true, _id: { $ne: userId } }));
}

const PHONE_ALREADY_USED_MESSAGE = 'Ce numéro est déjà vérifié sur un autre compte';

/**
 * Envoie un code de vérification par SMS au numéro de téléphone de l'utilisateur
 *
 * Le numéro peut être:
 * - Déjà enregistré dans le profil utilisateur
 * - Fourni dans la requête (facultatif)
 *
 * Si un nouveau numéro est fourni, il sera enregistré dans le profil
 * et le statut de vérification sera réinitialisé
 *
 * @param req - Requête Express avec optionnellement un numéro de téléphone
 * @param res - Réponse Express
 */
export const sendVerificationCode = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = (req.user as any).id;

    if (!userId) {
      res.status(400).json({ message: 'ID utilisateur non trouvé' });
      return;
    }

    const user = await User.findById(userId);

    if (!user) {
      res.status(404).json({ message: 'Utilisateur non trouvé' });
      return;
    }

    // Utiliser le numéro fourni ou celui déjà enregistré
    const rawPhoneNumber = req.body.phoneNumber || user.phoneNumber;

    if (!rawPhoneNumber) {
      res.status(400).json({ message: 'Numéro de téléphone requis' });
      return;
    }

    const phoneNumber = normalizePhoneNumber(rawPhoneNumber);
    if (!phoneNumber) {
      res.status(400).json({ message: 'Format de numéro de téléphone invalide' });
      return;
    }

    // Vérifié avant l'envoi : chaque SMS est facturé.
    if (await isPhoneVerifiedByAnotherUser(phoneNumber, userId)) {
      res.status(409).json({ message: PHONE_ALREADY_USED_MESSAGE });
      return;
    }

    // Si le numéro change, mettre à jour et réinitialiser la vérification
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

    // Envoyer le SMS
    await sendVerificationSMS(phoneNumber, verificationCode);

    logger.info('Code de vérification téléphone envoyé', {
      userId: user._id,
      phoneNumber: phoneNumber.replace(/\d(?=\d{4})/g, '*') // Masquer pour confidentialité
    });

    res.status(200).json({ message: 'Un code de vérification a été envoyé par SMS' });
  } catch (error) {
    if (error instanceof SmsUnavailableError) {
      logger.error('Envoi de SMS demandé alors que Twilio n\'est pas configuré');
      res.status(503).json({ message: error.message });
      return;
    }
    logger.error('Erreur lors de l\'envoi du code de vérification:', error);
    res.status(500).json({ message: 'Erreur lors de l\'envoi du code de vérification' });
  }
};

/**
 * Vérifie le code SMS reçu et marque le téléphone comme vérifié
 *
 * @param req - Requête Express contenant le code de vérification
 * @param res - Réponse Express
 */
export const verifyPhoneNumber = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = (req.user as any).id;
    const { code } = req.body;

    if (!code) {
      res.status(400).json({ message: 'Code de vérification requis' });
      return;
    }

    const user = await User.findById(userId).select('+phoneVerificationCode +phoneVerificationAttempts');

    if (!user) {
      res.status(404).json({ message: 'Utilisateur non trouvé' });
      return;
    }

    if (!user.phoneVerificationCode || !user.phoneVerificationExpires) {
      res.status(400).json({ message: 'Aucun code de vérification n\'a été demandé' });
      return;
    }

    if (user.phoneVerificationExpires < new Date()) {
      res.status(400).json({ message: 'Le code de vérification a expiré, veuillez en demander un nouveau' });
      return;
    }

    if (!isVerificationCodeEqual(user.phoneVerificationCode, code)) {
      const attempts = (user.phoneVerificationAttempts ?? 0) + 1;
      if (attempts >= MAX_CODE_ATTEMPTS) {
        user.phoneVerificationCode = undefined;
        user.phoneVerificationExpires = undefined;
        user.phoneVerificationAttempts = undefined;
        await user.save();
        res.status(400).json({ message: 'Trop de tentatives : demandez un nouveau code' });
        return;
      }
      user.phoneVerificationAttempts = attempts;
      await user.save();
      res.status(400).json({ message: 'Code de vérification incorrect' });
      return;
    }

    // Deux comptes ont pu demander un code pour le même numéro : seul le
    // premier à le valider le garde.
    if (user.phoneNumber && await isPhoneVerifiedByAnotherUser(user.phoneNumber, userId)) {
      res.status(409).json({ message: PHONE_ALREADY_USED_MESSAGE });
      return;
    }

    // Le code est valide, marquer le numéro comme vérifié
    user.isPhoneVerified = true;
    user.phoneVerificationCode = undefined;
    user.phoneVerificationExpires = undefined;
    user.phoneVerificationAttempts = undefined;

    await user.save();

    logger.info('Numéro de téléphone vérifié avec succès', { userId });

    res.status(200).json({
      message: 'Numéro de téléphone vérifié avec succès',
      isPhoneVerified: true
    });
  } catch (error) {
    logger.error('Erreur lors de la vérification du numéro de téléphone:', error);
    res.status(500).json({ message: 'Erreur lors de la vérification du numéro de téléphone' });
  }
};
