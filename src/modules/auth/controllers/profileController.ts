import { Request, Response } from 'express';
import User from '../../../models/userModel';
import { validateEmail, validateUsername } from '../../../commons/utils/validators';
import { sendVerificationEmail, sendAccountDeletionEmail } from '../../../commons/services/emailService';
import { invalidateAllUserRefreshTokens } from '../../../commons/services/tokenService';

/**
 * Récupération du profil utilisateur
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
    console.error('Erreur lors de la récupération du profil:', error);
    res.status(500).json({ message: 'Erreur lors de la récupération du profil' });
  }
};

/**
 * Mise à jour du profil utilisateur
 */
export const updateProfile = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = (req.user as any).id;
    
    const user = await User.findById(userId);
    
    if (!user) {
      res.status(404).json({ message: 'Utilisateur non trouvé' });
      return;
    }
    
    const { username, email } = req.body;
    let emailUpdated = false;
    
    // Mise à jour du nom d'utilisateur
    if (username && username !== user.username) {
      if (!validateUsername(username)) {
        res.status(400).json({ message: 'Format de nom d\'utilisateur invalide' });
        return;
      }
      
      const existingUser = await User.findOne({ username });
      if (existingUser) {
        res.status(400).json({ message: 'Ce nom d\'utilisateur est déjà utilisé' });
        return;
      }
      
      user.username = username;
    }
    
    // Mise à jour de l'email
    if (email && email !== user.email) {
      if (!validateEmail(email)) {
        res.status(400).json({ message: 'Format d\'email invalide' });
        return;
      }
      
      const existingUser = await User.findOne({ email });
      if (existingUser) {
        res.status(400).json({ message: 'Cet email est déjà utilisé' });
        return;
      }
      
      user.email = email;
      user.isEmailVerified = false;
      emailUpdated = true;
      
      // Générer un nouveau token de vérification
      const verificationToken = user.generateVerificationToken();
      
      // Envoyer l'email de vérification
      await sendVerificationEmail(user, verificationToken);
    }
    
    await user.save();
    
    res.status(200).json({
      message: emailUpdated 
        ? 'Profil mis à jour. Veuillez vérifier votre nouvelle adresse email.' 
        : 'Profil mis à jour avec succès',
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        isEmailVerified: user.isEmailVerified,
        isPhoneVerified: user.isPhoneVerified
      }
    });
  } catch (error) {
    console.error('Erreur lors de la mise à jour du profil:', error);
    res.status(500).json({ message: 'Erreur lors de la mise à jour du profil' });
  }
};

/**
 * Suppression du compte utilisateur
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
    await sendAccountDeletionEmail(user);
    
    // Invalider tous les refresh tokens de l'utilisateur
    await invalidateAllUserRefreshTokens(userId);
    
    res.status(200).json({ message: 'Votre compte a été supprimé avec succès' });
  } catch (error) {
    console.error('Erreur lors de la suppression du compte:', error);
    res.status(500).json({ message: 'Erreur lors de la suppression du compte' });
  }
};