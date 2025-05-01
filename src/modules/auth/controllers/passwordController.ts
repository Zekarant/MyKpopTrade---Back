import { Request, Response } from 'express';
import User from '../../../models/userModel';
import { sendPasswordResetEmail } from '../../../commons/services/emailService';
import { validatePassword } from '../../../commons/utils/validators';

/**
 * Demande de réinitialisation de mot de passe
 */
export const forgotPassword = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email } = req.body;
    
    if (!email) {
      res.status(400).json({ message: 'Email requis' });
      return;
    }

    const user = await User.findOne({ email });
    
    if (!user) {
      // Pour des raisons de sécurité, ne pas révéler si l'email existe
      res.status(200).json({ message: 'Si cet email est associé à un compte, un lien de réinitialisation a été envoyé.' });
      return;
    }

    // Générer un token de réinitialisation
    const resetToken = user.generatePasswordResetToken();
    await user.save();

    // Envoyer l'email
    await sendPasswordResetEmail(user, resetToken);

    res.status(200).json({
      message: 'Un lien de réinitialisation de mot de passe a été envoyé à votre adresse email.'
    });
  } catch (error) {
    console.error('Erreur lors de la demande de réinitialisation de mot de passe:', error);
    res.status(500).json({ message: 'Erreur lors de la demande de réinitialisation de mot de passe' });
  }
};

/**
 * Réinitialisation du mot de passe avec token
 */
export const resetPassword = async (req: Request, res: Response): Promise<void> => {
  try {
    const { token } = req.params;
    const { password, confirmPassword } = req.body;
    
    if (!password || !confirmPassword) {
      res.status(400).json({ message: 'Les champs mot de passe et confirmation sont requis' });
      return;
    }

    if (password !== confirmPassword) {
      res.status(400).json({ message: 'Les mots de passe ne correspondent pas' });
      return;
    }

    if (!validatePassword(password)) {
      res.status(400).json({ 
        message: 'Le mot de passe doit contenir au moins 8 caractères dont une majuscule, une minuscule, un chiffre et un caractère spécial' 
      });
      return;
    }

    const user = await User.findOne({
      passwordResetToken: token,
      passwordResetExpires: { $gt: Date.now() },
      accountStatus: { $ne: 'deleted' }
    });

    if (!user) {
      res.status(400).json({ message: 'Token de réinitialisation invalide ou expiré' });
      return;
    }

    // Mettre à jour le mot de passe
    user.password = password;
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    await user.save();

    res.status(200).json({ message: 'Mot de passe réinitialisé avec succès. Vous pouvez maintenant vous connecter.' });
  } catch (error) {
    console.error('Erreur lors de la réinitialisation du mot de passe:', error);
    res.status(500).json({ message: 'Erreur lors de la réinitialisation du mot de passe' });
  }
};

/**
 * Mise à jour du mot de passe (utilisateur connecté)
 */
export const updatePassword = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = (req.user as any).id;
    
    const user = await User.findById(userId);
    
    if (!user) {
      res.status(404).json({ message: 'Utilisateur non trouvé' });
      return;
    }
    
    const { currentPassword, newPassword, confirmPassword } = req.body;
    
    if (!currentPassword || !newPassword || !confirmPassword) {
      res.status(400).json({ message: 'Tous les champs sont obligatoires' });
      return;
    }

    // Vérification du mot de passe actuel
    const isPasswordValid = await user.comparePassword(currentPassword);
    if (!isPasswordValid) {
      res.status(401).json({ message: 'Mot de passe actuel incorrect' });
      return;
    }

    // Vérification de la correspondance des nouveaux mots de passe
    if (newPassword !== confirmPassword) {
      res.status(400).json({ message: 'Les nouveaux mots de passe ne correspondent pas' });
      return;
    }

    // Vérification de la complexité du nouveau mot de passe
    if (!validatePassword(newPassword)) {
      res.status(400).json({ 
        message: 'Le mot de passe doit contenir au moins 8 caractères dont une majuscule, une minuscule, un chiffre et un caractère spécial' 
      });
      return;
    }

    // Mise à jour du mot de passe
    user.password = newPassword;
    await user.save();
    
    res.status(200).json({ message: 'Mot de passe mis à jour avec succès' });
  } catch (error) {
    console.error('Erreur lors de la mise à jour du mot de passe:', error);
    res.status(500).json({ message: 'Erreur lors de la mise à jour du mot de passe' });
  }
};