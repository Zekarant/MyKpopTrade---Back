import { Request, Response } from 'express';
import User from '../../../models/userModel';
import { sendPasswordResetEmail } from '../../../commons/services/emailService';
import { validatePassword } from '../../../commons/utils/validators';
import { asyncHandler } from '../../../commons/middlewares/errorMiddleware';
import logger from '../../../commons/utils/logger';

interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: string;
  };
}

/**
 * Demande de réinitialisation de mot de passe
 */
export const forgotPassword = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { email } = req.body;
  
  if (!email) {
    res.status(400).json({ message: 'Email requis' });
    return;
  }

  const user = await User.findOne({ email });
  
  if (!user) {
    // Pour des raisons de sécurité, ne pas révéler si l'email existe
    res.status(200).json({ 
      message: 'Si cet email est associé à un compte, un lien de réinitialisation a été envoyé.' 
    });
    return;
  }

  // Générer un token de réinitialisation
  const resetToken = user.generatePasswordResetToken();
  await user.save();

  // Envoyer l'email
  await sendPasswordResetEmail(user, resetToken);

  logger.info('Demande de réinitialisation de mot de passe', { 
    email: user.email,
    userId: user._id 
  });

  res.status(200).json({
    message: 'Un lien de réinitialisation de mot de passe a été envoyé à votre adresse email.'
  });
});

/**
 * Réinitialisation du mot de passe avec token
 */
export const resetPassword = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { token } = req.params;
  const { password, confirmPassword } = req.body;
  
  if (!password || !confirmPassword) {
    res.status(400).json({ 
      message: 'Les champs mot de passe et confirmation sont requis' 
    });
    return;
  }

  if (password !== confirmPassword) {
    res.status(400).json({ 
      message: 'Les mots de passe ne correspondent pas' 
    });
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
    res.status(400).json({ 
      message: 'Token de réinitialisation invalide ou expiré' 
    });
    return;
  }

  // Mettre à jour le mot de passe
  user.password = password;
  user.passwordResetToken = undefined;
  user.passwordResetExpires = undefined;
  await user.save();

  logger.info('Mot de passe réinitialisé avec succès', { 
    userId: user._id,
    email: user.email 
  });

  res.status(200).json({ 
    message: 'Mot de passe réinitialisé avec succès. Vous pouvez maintenant vous connecter.' 
  });
});

/**
 * Mise à jour du mot de passe de l'utilisateur connecté
 */
export const updatePassword = asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const userId = req.user?.id;
  
  if (!userId) {
    res.status(401).json({ message: 'Authentification requise' });
    return;
  }
  
  const user = await User.findById(userId).select('+password');
  
  if (!user) {
    res.status(404).json({ message: 'Utilisateur non trouvé' });
    return;
  }
  
  const { currentPassword, newPassword, confirmPassword } = req.body;
  
  if (!currentPassword || !newPassword || !confirmPassword) {
    res.status(400).json({ 
      message: 'Tous les champs sont obligatoires' 
    });
    return;
  }

  // Vérification du mot de passe actuel
  try {
    const isPasswordValid = await user.comparePassword(currentPassword);
    if (!isPasswordValid) {
      res.status(401).json({ 
        message: 'Mot de passe actuel incorrect' 
      });
      return;
    }
  } catch (error) {
    logger.error('Erreur lors de la vérification du mot de passe actuel', {
      error: error instanceof Error ? error.message : 'Erreur inconnue',
      userId
    });
    res.status(500).json({ 
      message: 'Erreur lors de la vérification du mot de passe' 
    });
    return;
  }

  // Vérification de la correspondance des nouveaux mots de passe
  if (newPassword !== confirmPassword) {
    res.status(400).json({ 
      message: 'Les nouveaux mots de passe ne correspondent pas' 
    });
    return;
  }

  // Vérification de la complexité du nouveau mot de passe
  if (!validatePassword(newPassword)) {
    res.status(400).json({ 
      message: 'Le mot de passe doit contenir au moins 8 caractères dont une majuscule, une minuscule, un chiffre et un caractère spécial' 
    });
    return;
  }

  // Vérification que le nouveau mot de passe est différent de l'ancien
  try {
    const isSamePassword = await user.comparePassword(newPassword);
    if (isSamePassword) {
      res.status(400).json({ 
        message: 'Le nouveau mot de passe doit être différent de l\'ancien' 
      });
      return;
    }
  } catch (error) {
    logger.error('Erreur lors de la comparaison avec l\'ancien mot de passe', {
      error: error instanceof Error ? error.message : 'Erreur inconnue',
      userId
    });
  }

  // Mise à jour du mot de passe
  user.password = newPassword;
  user.lastLoginAt = new Date(); // Mettre à jour la dernière activité
  await user.save();
  
  logger.info('Mot de passe mis à jour avec succès', { 
    userId: user._id,
    email: user.email 
  });
  
  res.status(200).json({ 
    message: 'Mot de passe mis à jour avec succès' 
  });
});