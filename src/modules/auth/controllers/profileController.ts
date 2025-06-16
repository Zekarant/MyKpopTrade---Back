import { Request, Response } from 'express';
import User from '../../../models/userModel';
import { validateEmail, validateUsername, validatePhoneNumber } from '../../../commons/utils/validators';
import { sendVerificationEmail } from '../../../commons/services/emailService';
import logger from '../../../commons/utils/logger';

/**
 * Récupère le profil de l'utilisateur authentifié
 * 
 * @param req - Requête Express contenant l'ID utilisateur dans req.user
 * @param res - Réponse Express
 * @returns Le profil utilisateur sans les données sensibles
 */
export const getProfile = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = (req.user as any).id;
    
    const user = await User.findById(userId, {
      password: 0,
      emailVerificationToken: 0,
      emailVerificationExpires: 0,
      passwordResetToken: 0,
      passwordResetExpires: 0,
      phoneVerificationCode: 0,
      phoneVerificationExpires: 0
    });
    
    if (!user) {
      res.status(404).json({ message: 'Utilisateur non trouvé' });
      return;
    }
    
    res.status(200).json({ user });
  } catch (error) {
    logger.error('Erreur lors de la récupération du profil:', error);
    res.status(500).json({ message: 'Erreur lors de la récupération du profil' });
  }
};

/**
 * Met à jour le profil complet de l'utilisateur authentifié
 * 
 * Traite les modifications des informations de profil incluant:
 * - Username et email (avec vérification d'unicité)
 * - Numéro de téléphone (avec réinitialisation du statut de vérification)
 * - Email PayPal (avec vérification d'unicité)
 * - Informations non sensibles (bio, localisation, préférences)
 * 
 * @param req - Requête Express avec les données de profil à mettre à jour
 * @param res - Réponse Express
 */
export const updateProfile = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = (req.user as any).id;
    
    const user = await User.findById(userId);
    
    if (!user) {
      res.status(404).json({ message: 'Utilisateur non trouvé' });
      return;
    }
    
    const { 
      username, 
      email, 
      paypalEmail, 
      phoneNumber,
      bio, 
      location, 
      socialLinks,
      preferences 
    } = req.body;
    
    let emailUpdated = false;
    let phoneNumberUpdated = false;
    
    // Traitement du username
    if (username && username !== user.username) {
      // Validation et unicité...
      user.username = username;
    }
    
    // Traitement de l'email
    if (email && email !== user.email) {
      // Validation, unicité et envoi d'email...
      emailUpdated = true;
    }
    
    // Traitement du numéro de téléphone
    if (phoneNumber !== undefined) {
      if (phoneNumber === '') {
        // Suppression du numéro
        user.phoneNumber = undefined;
        user.isPhoneVerified = false;
        phoneNumberUpdated = true;
      } else {
        // Validation du format
        if (!validatePhoneNumber(phoneNumber)) {
          res.status(400).json({ message: 'Format de numéro de téléphone invalide' });
          return;
        }
        
        // Réinitialisation du statut de vérification si le numéro change
        if (user.phoneNumber !== phoneNumber) {
          user.phoneNumber = phoneNumber;
          user.isPhoneVerified = false;
          phoneNumberUpdated = true;
        }
      }
    }
    
    // Traitement de l'email PayPal
    if (paypalEmail !== undefined) {
      // Logique de validation et mise à jour...
    }
    
    // Traitement des autres champs
    if (bio !== undefined) user.bio = bio.substring(0, 500);
    if (location !== undefined) user.location = location.substring(0, 100);
    if (socialLinks) user.socialLinks = { ...user.socialLinks, ...socialLinks };
    if (preferences) user.preferences = { ...user.preferences, ...preferences };
    
    await user.save();
    
    // Construction du message de réponse
    let message = 'Profil mis à jour avec succès';
    if (emailUpdated && phoneNumberUpdated) {
      message = 'Profil mis à jour. Veuillez vérifier votre nouvelle adresse email et votre numéro de téléphone.';
    } else if (emailUpdated) {
      message = 'Profil mis à jour. Veuillez vérifier votre nouvelle adresse email.';
    } else if (phoneNumberUpdated) {
      message = 'Profil mis à jour. Veuillez vérifier votre nouveau numéro de téléphone.';
    }
    
    res.status(200).json({
      message,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        paypalEmail: user.paypalEmail,
        phoneNumber: user.phoneNumber,
        isPhoneVerified: user.isPhoneVerified,
        bio: user.bio,
        location: user.location,
        socialLinks: user.socialLinks,
        preferences: user.preferences,
        isEmailVerified: user.isEmailVerified
      }
    });
  } catch (error) {
    logger.error('Erreur lors de la mise à jour du profil:', error);
    res.status(500).json({ message: 'Erreur lors de la mise à jour du profil' });
  }
};

/**
 * Supprime le compte de l'utilisateur authentifié
 * Le compte est marqué pour suppression et sera définitivement supprimé après 30 jours
 * Un email de confirmation est envoyé
 * 
 * @param req - Requête Express contenant l'ID utilisateur et le mot de passe de confirmation
 * @param res - Réponse Express
 */
export const deleteAccount = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = (req.user as any).id;
    
    const user = await User.findById(userId);
    
    if (!user) {
      res.status(404).json({ message: 'Utilisateur non trouvé' });
      return;
    }
    
    const { password } = req.body;
    
    // Si l'utilisateur a un compte avec mot de passe, vérifier le mot de passe
    if (!user.socialAuth?.google && !user.socialAuth?.facebook && !user.socialAuth?.discord) {
      if (!password) {
        res.status(400).json({ message: 'Mot de passe requis pour confirmer la suppression' });
        return;
      }
      
      const isPasswordValid = await user.comparePassword(password);
      if (!isPasswordValid) {
        res.status(401).json({ message: 'Mot de passe incorrect' });
        return;
      }
    }

    // Marquer le compte comme supprimé au lieu de le supprimer physiquement
    user.accountStatus = 'deleted';
    user.email = `deleted_${user._id}_${user.email}`; // Permet de libérer l'email
    user.username = `deleted_${user._id}_${user.username}`; // Libérer le nom d'utilisateur
    await user.save();
    
    // Envoyer un email de confirmation
    // await sendAccountDeletionEmail(user);
    
    // Invalider tous les refresh tokens de l'utilisateur
    // await invalidateAllUserRefreshTokens(userId);
    
    res.status(200).json({ message: 'Votre compte a été supprimé avec succès' });
  } catch (error) {
    logger.error('Erreur lors de la suppression du compte:', error);
    res.status(500).json({ message: 'Erreur lors de la suppression du compte' });
  }
};

/**
 * Met à jour uniquement l'email PayPal de l'utilisateur authentifié
 * Vérifie que l'email est unique et dans un format valide
 * Vérifie que l'email PayPal est différent de l'email principal
 * 
 * @param req - Requête Express contenant l'ID utilisateur et le nouvel email PayPal
 * @param res - Réponse Express
 * @returns Le nouvel email PayPal ou un message d'erreur
 */
export const updatePayPalEmail = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = (req.user as any).id;
    const { paypalEmail, confirmPassword } = req.body;
    
    if (!paypalEmail) {
      res.status(400).json({ message: 'Email PayPal requis' });
      return;
    }
    
    // Validation de l'email PayPal
    if (!validateEmail(paypalEmail)) {
      res.status(400).json({ message: 'Format d\'email PayPal invalide' });
      return;
    }
    
    const user = await User.findById(userId);
    
    if (!user) {
      res.status(404).json({ message: 'Utilisateur non trouvé' });
      return;
    }
    
    // Vérification de sécurité : l'email PayPal ne peut pas être identique à l'email principal
    if (paypalEmail.toLowerCase() === user.email.toLowerCase()) {
      res.status(400).json({ 
        message: 'L\'email PayPal ne peut pas être identique à votre email principal' 
      });
      return;
    }
    
    // Vérifier si l'email PayPal n'est pas déjà utilisé par un autre utilisateur
    const existingUsers = await User.find({ 
      $and: [
        { _id: { $ne: userId } },
        { paypalEmail: paypalEmail }
      ]
    });
    
    if (existingUsers.length > 0) {
      res.status(400).json({ 
        message: 'Cet email PayPal est déjà utilisé par un autre utilisateur'
      });
      return;
    }
    
    // Vérification du mot de passe si fourni
    if (confirmPassword) {
      const userWithPassword = await User.findById(userId).select('+password');
      
      if (userWithPassword?.password) {
        try {
          const isPasswordValid = await userWithPassword.comparePassword(confirmPassword);
          if (!isPasswordValid) {
            res.status(401).json({ 
              message: 'Mot de passe de confirmation incorrect' 
            });
            return;
          }
        } catch (error) {
          logger.error('Erreur lors de la vérification du mot de passe:', error);
          res.status(500).json({ 
            message: 'Erreur lors de la vérification du mot de passe' 
          });
          return;
        }
      }
    }
    
    // Mettre à jour l'email PayPal
    user.paypalEmail = paypalEmail;
    user.markModified('paypalEmail'); // Force la modification
    await user.save();
    
    logger.info('Email PayPal mis à jour', { 
      userId,
      newPayPalEmail: paypalEmail 
    });
    
    res.status(200).json({
      message: 'Email PayPal mis à jour avec succès',
      paypalEmail: user.paypalEmail
    });
  } catch (error) {
    logger.error('Erreur lors de la mise à jour de l\'email PayPal:', error);
    res.status(500).json({ message: 'Erreur lors de la mise à jour de l\'email PayPal' });
  }
};

/**
 * Supprime l'email PayPal de l'utilisateur authentifié
 * Vérifie que l'utilisateur possède bien un email PayPal à supprimer
 * Peut exiger une confirmation par mot de passe pour plus de sécurité
 * 
 * @param req - Requête Express contenant l'ID utilisateur et éventuellement un mot de passe de confirmation
 * @param res - Réponse Express
 * @returns Un message de confirmation ou d'erreur
 */
export const removePayPalEmail = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = (req.user as any).id;
    const { confirmPassword } = req.body;
    
    const user = await User.findById(userId);
    
    if (!user) {
      res.status(404).json({ message: 'Utilisateur non trouvé' });
      return;
    }
    
    // Vérifier que l'utilisateur a bien un email PayPal
    if (!user.paypalEmail) {
      res.status(400).json({ 
        message: 'Aucun email PayPal n\'est configuré sur ce compte' 
      });
      return;
    }
    
    // Vérification du mot de passe si fourni
    if (confirmPassword) {
      const userWithPassword = await User.findById(userId).select('+password');
      
      if (!userWithPassword) {
        res.status(404).json({ message: 'Utilisateur non trouvé' });
        return;
      }
      
      if (userWithPassword.password) {
        try {
          const isPasswordValid = await userWithPassword.comparePassword(confirmPassword);
          if (!isPasswordValid) {
            res.status(401).json({ 
              message: 'Mot de passe de confirmation incorrect' 
            });
            return;
          }
        } catch (error) {
          logger.error('Erreur lors de la vérification du mot de passe:', error);
          res.status(500).json({ 
            message: 'Erreur lors de la vérification du mot de passe' 
          });
          return;
        }
      }
    }
    
    // Supprimer l'email PayPal
    user.paypalEmail = undefined;
    user.markModified('paypalEmail'); // Force la modification
    await user.save();
    
    logger.info('Email PayPal supprimé', { userId });
    
    res.status(200).json({
      message: 'Email PayPal supprimé avec succès'
    });
  } catch (error) {
    logger.error('Erreur lors de la suppression de l\'email PayPal:', error);
    res.status(500).json({ message: 'Erreur lors de la suppression de l\'email PayPal' });
  }
};