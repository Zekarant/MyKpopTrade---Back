import { Request, Response } from 'express';
import User from '../../../models/userModel';
import { sendVerificationSMS, generateVerificationCode } from '../../../commons/services/smsService';
import { validatePhoneNumber } from '../../../commons/utils/validators';

/**
 * Envoie un code de vérification par SMS
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
    
    const { phoneNumber } = req.body;
    
    if (!phoneNumber) {
      res.status(400).json({ message: 'Numéro de téléphone requis' });
      return;
    }

    if (!validatePhoneNumber(phoneNumber)) {
      res.status(400).json({ message: 'Format de numéro de téléphone invalide' });
      return;
    }

    // Mise à jour du numéro de téléphone
    user.phoneNumber = phoneNumber;
    
    // Génération du code de vérification
    const verificationCode = generateVerificationCode();
    user.phoneVerificationCode = verificationCode;
    user.phoneVerificationExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
    
    await user.save();

    // Envoi du SMS
    await sendVerificationSMS(phoneNumber, verificationCode);
    
    res.status(200).json({ message: 'Un code de vérification a été envoyé par SMS' });
  } catch (error) {
    console.error('Erreur lors de l\'envoi du code de vérification:', error);
    res.status(500).json({ message: 'Erreur lors de l\'envoi du code de vérification' });
  }
};

/**
 * Vérifie le code SMS et valide le numéro de téléphone
 */
export const verifyPhoneNumber = async (req: Request, res: Response): Promise<void> => {
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
    
    const { code } = req.body;
    
    if (!code) {
      res.status(400).json({ message: 'Code de vérification requis' });
      return;
    }

    if (!user.phoneVerificationCode || !user.phoneVerificationExpires) {
      res.status(400).json({ message: 'Aucun code de vérification en attente' });
      return;
    }

    if (user.phoneVerificationExpires < new Date()) {
      res.status(400).json({ message: 'Code de vérification expiré' });
      return;
    }

    if (user.phoneVerificationCode !== code) {
      res.status(400).json({ message: 'Code de vérification incorrect' });
      return;
    }

    // Valider le numéro de téléphone
    user.isPhoneVerified = true;
    user.phoneVerificationCode = undefined;
    user.phoneVerificationExpires = undefined;
    await user.save();

    res.status(200).json({ message: 'Numéro de téléphone vérifié avec succès' });
  } catch (error) {
    console.error('Erreur lors de la vérification du téléphone:', error);
    res.status(500).json({ message: 'Erreur lors de la vérification du téléphone' });
  }
};