import { Request, Response, NextFunction, RequestHandler } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import passport from 'passport';
import User, { IUser } from '../models/userModel';
import { validatePassword, validateEmail } from '../utils/validators';

// Liste de révocation des tokens (blacklist)
const tokenBlacklist = new Set<string>();

// Fonction commune pour générer un token JWT
export const generateToken = (req: Request, res: Response): void => {
  const user = req.user as IUser;
  
  if (!user) {
    res.status(400).json({ message: 'Erreur lors de l\'authentification.' });
    return;
  }

  const token = jwt.sign(
    { 
      id: user._id,
      username: user.username,
      email: user.email 
    }, 
    process.env.JWT_SECRET || 'userLogin', 
    { expiresIn: '24h' }
  );

  // Redirection pour les authentifications sociales
  if (req.query.redirect) {
    res.redirect(`${req.query.redirect}?token=${token}`);
    return;
  }

  res.status(200).json({ 
    message: 'Connexion réussie !',
    token,
    user: {
      id: user._id,
      username: user.username,
      email: user.email
    }
  });
};

export const register: RequestHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const { username, email, numberPhone, password, confirmPassword } = req.body;

    try {
        // Validation des champs requis
        const missingFields = [];
        if (!username) missingFields.push('nom d\'utilisateur');
        if (!email) missingFields.push('email');
        if (!numberPhone) missingFields.push('numéro de téléphone');
        if (!password) missingFields.push('mot de passe');
        if (!confirmPassword) missingFields.push('confirmation du mot de passe');
        
        if (missingFields.length > 0) {
            res.status(400).json({ 
                message: `Veuillez renseigner tous les champs obligatoires : ${missingFields.join(', ')}.` 
            });
            return;
        }

        // Vérification du format de l'email
        if (!validateEmail(email)) {
            res.status(400).json({ message: 'Le format de l\'adresse email est invalide.' });
            return;
        }

        // Vérification de la complexité du mot de passe
        if (!validatePassword(password)) {
            res.status(400).json({ 
                message: 'Le mot de passe doit contenir au moins 8 caractères, incluant une majuscule, une minuscule, un chiffre et un caractère spécial.' 
            });
            return;
        }

        // Vérification de la correspondance des mots de passe
        if (password !== confirmPassword) {
            res.status(400).json({ message: 'Les mots de passe ne correspondent pas.' });
            return;
        }

        // Vérification si l'email existe déjà
        const existingEmailUser = await User.findOne({ email });
        if (existingEmailUser) {
            res.status(400).json({ message: 'Cette adresse email est déjà utilisée.' });
            return;
        }

        // Vérification si le nom d'utilisateur existe déjà
        const existingUsernameUser = await User.findOne({ username });
        if (existingUsernameUser) {
            res.status(400).json({ message: 'Ce nom d\'utilisateur est déjà utilisé.' });
            return;
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser: IUser = new User({ username, email, numberPhone, password: hashedPassword });
        
        await newUser.save();
        res.status(201).json({ message: 'Inscription réussie ! Vous pouvez maintenant vous connecter.' });
    } catch (error) {
        console.error('Erreur lors de l\'inscription:', error);
        
        // Gestion améliorée des erreurs de validation Mongoose
        if (error instanceof Error && (error as any).name === 'ValidationError') {
            const validationErrors: Record<string, string> = {};
            const messagesFrançais = {
                'username': 'Le nom d\'utilisateur est obligatoire',
                'email': 'L\'adresse email est obligatoire',
                'numberPhone': 'Le numéro de téléphone est obligatoire',
                'password': 'Le mot de passe est obligatoire'
            };
            
            // Transformer les erreurs techniques en messages compréhensibles
            Object.keys((error as any).errors || {}).forEach(field => {
                validationErrors[field] = messagesFrançais[field as keyof typeof messagesFrançais] || (error as any).errors[field].message;
            });
            
            res.status(400).json({ 
                message: 'Veuillez corriger les erreurs suivantes',
                errors: validationErrors 
            });
        } else {
            res.status(500).json({ message: 'Une erreur est survenue lors de l\'inscription. Veuillez réessayer.' });
        }
    }
};

export const login: RequestHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const { username, email, password } = req.body;

    try {
        // Vérification si l'utilisateur existe via email ou username
        const user = await User.findOne({
            $or: [{ email: email }, { username: username }]
        });

        if (!user) {
            res.status(400).json({ message: 'Identifiant ou mot de passe incorrect.' });
            return;
        }

        // Vérification du mot de passe
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            res.status(400).json({ message: 'Identifiant ou mot de passe incorrect.' });
            return;
        }

        // Génération du token JWT
        const token = jwt.sign(
            { 
                id: user._id,
                username: user.username,
                email: user.email 
            }, 
            process.env.JWT_SECRET || 'userLogin', 
            { expiresIn: '24h' }
        );

        res.status(200).json({ 
            message: 'Connexion réussie !',
            token,
            user: {
                id: user._id,
                username: user.username,
                email: user.email
            }
        });
    } catch (error) {
        console.error('Erreur lors de la connexion:', error);
        res.status(500).json({ message: 'Une erreur est survenue lors de la connexion. Veuillez réessayer.' });
    }
};

export const logout: RequestHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const authHeader = req.headers.authorization;
        
        if (!authHeader) {
            res.status(401).json({ message: 'Vous devez être connecté pour vous déconnecter.' });
            return;
        }

        const token = authHeader.split(' ')[1]; // Format: "Bearer TOKEN"
        
        if (!token) {
            res.status(401).json({ message: 'Token d\'authentification non fourni.' });
            return;
        }

        // Vérifier si le token est valide avant de l'ajouter à la blacklist
        try {
            jwt.verify(token, process.env.JWT_SECRET || 'userLogin');
            
            // Ajouter le token à la blacklist
            tokenBlacklist.add(token);
            
            // Vérifier que le token est bien dans la blacklist
            const isBlacklisted = tokenBlacklist.has(token);
            
            if (isBlacklisted) {
                res.status(200).json({ message: 'Déconnexion réussie. Votre session a été fermée.' });
            } else {
                res.status(500).json({ message: 'Erreur lors de la déconnexion. Veuillez réessayer.' });
            }
        } catch (error) {
            // Si le token est déjà invalide ou expiré
            res.status(401).json({ message: 'Token d\'authentification invalide ou expiré.' });
        }
    } catch (error) {
        console.error('Erreur lors de la déconnexion:', error);
        res.status(500).json({ message: 'Une erreur est survenue lors de la déconnexion. Veuillez réessayer.' });
    }
};

// Middleware modifié pour utiliser Passport
export const verifyToken = passport.authenticate('jwt', { session: false });