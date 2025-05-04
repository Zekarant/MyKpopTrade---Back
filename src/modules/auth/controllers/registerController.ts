import { Request, Response } from 'express';
import User from '../../../models/userModel';
import { validateUsername, validateEmail, validatePassword } from '../../../commons/utils/validators';
import { sendVerificationEmail } from '../../../commons/services/emailService';

/**
 * Inscription d'un nouvel utilisateur
 */
export const register = async (req: Request, res: Response): Promise<void> => {
  try {
    const { username, email, password, confirmPassword } = req.body;
    
    // Validation des champs obligatoires
    if (!username || !email || !password || !confirmPassword) {
      res.status(400).json({ message: 'Tous les champs sont obligatoires' });
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

    // Création du nouvel utilisateur
    const newUser = new User({
      username,
      email,
      password
    });

    // Génération du token de vérification
    const verificationToken = newUser.generateVerificationToken();
    await newUser.save();

    // Envoi de l'email de vérification
    await sendVerificationEmail(newUser, verificationToken);

    res.status(201).json({
      message: 'Inscription réussie ! Veuillez vérifier votre email pour activer votre compte.',
      userId: newUser._id
    });
  } catch (error) {
    console.error('Erreur lors de l\'inscription:', error);
    res.status(500).json({ message: 'Erreur lors de l\'inscription. Veuillez réessayer.' });
  }
};