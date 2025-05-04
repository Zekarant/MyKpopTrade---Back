import { Request, Response } from 'express';
import User from '../../../models/userModel';
import { sendVerificationEmail } from '../../../commons/services/emailService';

/**
 * Vérification de l'email avec le token
 */
export const verifyEmail = async (req: Request, res: Response): Promise<void> => {
  try {
    const { token } = req.params;
    
    if (!token) {
      res.status(400).json({ message: 'Token de vérification requis' });
      return;
    }

    const user = await User.findOne({
      emailVerificationToken: token,
      emailVerificationExpires: { $gt: Date.now() },
      accountStatus: { $ne: 'deleted' }
    });

    if (!user) {
      res.status(400).json({ message: 'Token de vérification invalide ou expiré' });
      return;
    }

    // Marquer l'email comme vérifié
    user.isEmailVerified = true;
    user.emailVerificationToken = undefined;
    user.emailVerificationExpires = undefined;
    await user.save();

    res.status(200).json({ message: 'Email vérifié avec succès. Vous pouvez maintenant vous connecter.' });
  } catch (error) {
    console.error('Erreur lors de la vérification de l\'email:', error);
    res.status(500).json({ message: 'Erreur lors de la vérification de l\'email' });
  }
};

/**
 * Renvoi d'un email de vérification
 */
export const resendVerification = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email } = req.body;
    
    if (!email) {
      res.status(400).json({ message: 'Email requis' });
      return;
    }

    const user = await User.findOne({ email });
    
    if (!user) {
      // Pour des raisons de sécurité, ne pas révéler si l'email existe
      res.status(200).json({ message: 'Si cet email existe dans notre base de données, un nouveau lien de vérification a été envoyé.' });
      return;
    }

    if (user.isEmailVerified) {
      res.status(400).json({ message: 'Cette adresse email est déjà vérifiée' });
      return;
    }

    // Générer un nouveau token
    const verificationToken = user.generateVerificationToken();
    await user.save();

    // Envoyer l'email
    await sendVerificationEmail(user, verificationToken);

    res.status(200).json({ message: 'Un nouveau lien de vérification a été envoyé à votre adresse email' });
  } catch (error) {
    console.error('Erreur lors de l\'envoi du lien de vérification:', error);
    res.status(500).json({ message: 'Erreur lors de l\'envoi du lien de vérification' });
  }
};