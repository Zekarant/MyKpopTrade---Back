import { Request, Response } from 'express';
import User from '../../../models/userModel';
import { sendVerificationSMS, generateVerificationCode } from '../../../commons/services/smsService';
import { validatePhoneNumber } from '../../../commons/utils/validators';
import logger from '../../../commons/utils/logger';

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
    const phoneNumber = req.body.phoneNumber || user.phoneNumber;
    
    if (!phoneNumber) {
      res.status(400).json({ message: 'Numéro de téléphone requis' });
      return;
    }

    if (!validatePhoneNumber(phoneNumber)) {
      res.status(400).json({ message: 'Format de numéro de téléphone invalide' });
      return;
    }

    // Si le numéro change, mettre à jour et réinitialiser la vérification
    if (user.phoneNumber !== phoneNumber) {
      user.phoneNumber = phoneNumber;
      user.isPhoneVerified = false;
    }
    
    // Générer et enregistrer le code de vérification
    const verificationCode = generateVerificationCode();
    user.phoneVerificationCode = verificationCode;
    user.phoneVerificationExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
    
    await user.save();

    // Envoyer le SMS
    await sendVerificationSMS(phoneNumber, verificationCode);
    
    logger.info('Code de vérification téléphone envoyé', {
      userId: user._id,
      phoneNumber: phoneNumber.replace(/\d(?=\d{4})/g, '*') // Masquer pour confidentialité
    });
    
    res.status(200).json({ message: 'Un code de vérification a été envoyé par SMS' });
  } catch (error) {
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
    
    const user = await User.findById(userId);
    
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
    
    if (user.phoneVerificationCode !== code) {
      res.status(400).json({ message: 'Code de vérification incorrect' });
      return;
    }
    
    // Le code est valide, marquer le numéro comme vérifié
    user.isPhoneVerified = true;
    user.phoneVerificationCode = undefined;
    user.phoneVerificationExpires = undefined;
    
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