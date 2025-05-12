import { Request, Response } from 'express';
import User from '../../../models/userModel';
import { validateUsername, validateEmail, validatePassword } from '../../../commons/utils/validators';
import { sendVerificationEmail } from '../../../commons/services/emailService';
import logger from '../../../commons/utils/logger';

/**
 * Inscription d'un nouvel utilisateur avec gestion des consentements RGPD
 */
export const register = async (req: Request, res: Response): Promise<void> => {
  try {
    const { 
      username, 
      email, 
      password, 
      confirmPassword, 
      privacyPolicy,      // Nouveau paramètre pour le consentement à la politique de confidentialité
      dataProcessing,     // Nouveau paramètre pour le consentement au traitement des données
      marketing           // Nouveau paramètre pour le consentement marketing
    } = req.body;
    
    // Validation des champs obligatoires
    if (!username || !email || !password || !confirmPassword) {
      res.status(400).json({ message: 'Tous les champs sont obligatoires' });
      return;
    }

    // Vérification des consentements obligatoires
    if (privacyPolicy !== true) {
      res.status(400).json({ message: 'Vous devez accepter la politique de confidentialité pour vous inscrire' });
      return;
    }
    
    if (dataProcessing !== true) {
      res.status(400).json({ message: 'Vous devez accepter le traitement de vos données pour vous inscrire' });
      return;
    }

    // Validation du format des données
    if (!validateUsername(username)) {
      res.status(400).json({ message: 'Le nom d\'utilisateur doit contenir entre 3 et 30 caractères alphanumériques, underscore ou tiret' });
      return;
    }

    if (!validateEmail(email)) {
      res.status(400).json({ message: 'Format d\'email invalide' });
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

    // Vérification si l'utilisateur existe déjà
    const existingUser = await User.findOne({
      $or: [{ email }, { username }]
    });

    if (existingUser) {
      if (existingUser.email === email) {
        res.status(409).json({ message: 'Cet email est déjà utilisé' });
      } else {
        res.status(409).json({ message: 'Ce nom d\'utilisateur est déjà utilisé' });
      }
      return;
    }

    const now = new Date();

    // Création du nouvel utilisateur avec les consentements RGPD
    const newUser = new User({
      username,
      email,
      password,
      // Ajout des champs de consentement RGPD avec horodatage
      privacyPolicyAccepted: true,
      privacyPolicyAcceptedAt: now,
      dataProcessingConsent: true,
      dataProcessingConsentAt: now,
      marketingConsent: marketing === true,
      marketingConsentAt: marketing === true ? now : undefined,
      lastLoginAt: now
    });

    // Génération du token de vérification
    const verificationToken = newUser.generateVerificationToken();
    await newUser.save();

    // Envoi de l'email de vérification
    await sendVerificationEmail(newUser, verificationToken);

    // Journaliser l'inscription sans données personnelles
    logger.info('Nouvel utilisateur inscrit avec consentements RGPD', {
      userId: newUser._id.toString().substring(0, 5) + '...',
      privacyAccepted: true,
      dataProcessingAccepted: true,
      marketingAccepted: marketing === true
    });

    res.status(201).json({
      message: 'Inscription réussie ! Veuillez vérifier votre email pour activer votre compte.',
      userId: newUser._id,
      consentements: {
        privacyPolicy: true,
        dataProcessing: true,
        marketing: marketing === true
      }
    });
  } catch (error) {
    console.error('Erreur lors de l\'inscription:', error);
    res.status(500).json({ message: 'Erreur lors de l\'inscription. Veuillez réessayer.' });
  }
};