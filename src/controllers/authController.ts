import { Request, Response, NextFunction, RequestHandler } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import passport from 'passport';
import crypto from 'crypto';
import User, { IUser } from '../models/userModel';
import { validatePassword, validateEmail } from '../utils/validators';
import { sendVerificationEmail, sendPasswordResetEmail, sendAccountDeletionEmail } from '../services/emailService';
import { sendVerificationSMS, generateVerificationCode } from '../services/smsService';

// Liste de révocation des tokens (blacklist)
const tokenBlacklist = new Set<string>();

// Fonction commune pour générer un token JWT
const generateToken = (user: IUser): string => {
    return jwt.sign(
        { id: user._id, username: user.username, email: user.email },
        process.env.JWT_SECRET || 'default_jwt_secret',
        { expiresIn: '7d' }
    );
};

// Inscription classique
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

        const newUser = new User({
            username,
            email,
            password,
            isEmailVerified: false
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

// La fonction login modifiée pour accepter correctement email OU nom d'utilisateur
export const login = async (req: Request, res: Response): Promise<void> => {
    try {
        const { identifier, password } = req.body;

        // Ajouter des logs pour débugger
        console.log('Tentative de connexion avec :', { identifier });

        if (!identifier || !password) {
            res.status(400).json({ message: 'Email/nom d\'utilisateur et mot de passe sont requis' });
            return;
        }

        // Recherche de l'utilisateur par email OU nom d'utilisateur
        const user = await User.findOne({
            $or: [
                { email: identifier },
                { username: identifier }
            ],
            accountStatus: { $ne: 'deleted' }
        });

        // Ajouter un log pour voir si l'utilisateur est trouvé
        console.log('Utilisateur trouvé :', user ? user._id : 'Aucun');

        if (!user) {
            res.status(401).json({ message: 'Identifiants incorrects' });
            return;
        }

        // Vérification du mot de passe
        const isPasswordValid = await user.comparePassword(password);
        console.log('Mot de passe valide :', isPasswordValid);

        if (!isPasswordValid) {
            res.status(401).json({ message: 'Identifiants incorrects' });
            return;
        }

        // Vérification de l'activation du compte par email
        if (!user.isEmailVerified) {
            res.status(403).json({ message: 'Veuillez vérifier votre adresse email avant de vous connecter' });
            return;
        }

        // Mise à jour de la date de dernière connexion
        user.lastLogin = new Date();
        await user.save();

        // Génération du token
        const token = generateToken(user);

        res.status(200).json({
            message: 'Connexion réussie',
            token,
            user: {
                id: user._id,
                username: user.username,
                email: user.email,
                isEmailVerified: user.isEmailVerified,
                isPhoneVerified: user.isPhoneVerified
            }
        });
    } catch (error) {
        console.error('Erreur lors de la connexion:', error);
        res.status(500).json({ message: 'Erreur lors de la connexion. Veuillez réessayer.' });
    }
};

// Déconnexion
export const logout = async (req: Request, res: Response): Promise<void> => {
    try {
        const authHeader = req.headers.authorization;

        if (!authHeader) {
            res.status(401).json({ message: 'Non autorisé' });
            return;
        }

        const token = authHeader.split(' ')[1];

        if (!token) {
            res.status(400).json({ message: 'Token non fourni' });
            return;
        }

        try {
            // Vérifier que le token est valide avant de le blacklister
            jwt.verify(token, process.env.JWT_SECRET || 'default_jwt_secret');

            // Si on arrive ici, le token est valide
            // Ajout du token à la liste noire
            tokenBlacklist.add(token);

            res.status(200).json({ message: 'Déconnexion réussie' });
        } catch (tokenError) {
            // Si le token est déjà invalide, on considère quand même la déconnexion comme réussie
            res.status(200).json({ message: 'Déconnexion réussie (token déjà invalide)' });
        }
    } catch (error) {
        console.error('Erreur lors de la déconnexion:', error);
        res.status(500).json({ message: 'Erreur lors de la déconnexion' });
    }
};

// Vérification de l'email
export const verifyEmail = async (req: Request, res: Response): Promise<void> => {
    try {
        const { token } = req.params;

        if (!token) {
            res.status(400).json({ message: 'Token de vérification non fourni' });
            return;
        }

        // Hachage du token pour la comparaison
        const hashedToken = crypto
            .createHash('sha256')
            .update(token)
            .digest('hex');

        // Recherche de l'utilisateur avec ce token
        const user = await User.findOne({
            emailVerificationToken: hashedToken,
            emailVerificationExpires: { $gt: Date.now() }
        });

        if (!user) {
            res.status(400).json({ message: 'Token invalide ou expiré' });
            return;
        }

        // Activation du compte
        user.isEmailVerified = true;
        user.emailVerificationToken = undefined;
        user.emailVerificationExpires = undefined;
        await user.save();

        const authToken = generateToken(user);

        res.status(200).json({
            message: 'Adresse email vérifiée avec succès ! Votre compte est maintenant actif.',
            token: authToken
        });
    } catch (error) {
        console.error('Erreur lors de la vérification de l\'email:', error);
        res.status(500).json({ message: 'Erreur lors de la vérification de l\'email' });
    }
};

// Envoi d'un nouveau lien de vérification
export const resendVerificationEmail = async (req: Request, res: Response): Promise<void> => {
    try {
        const { email } = req.body;

        if (!email) {
            res.status(400).json({ message: 'Email requis' });
            return;
        }

        const user = await User.findOne({ email });

        if (!user) {
            // Pour des raisons de sécurité, ne pas indiquer si l'email existe ou non
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

// Demande de réinitialisation de mot de passe
export const forgotPassword = async (req: Request, res: Response): Promise<void> => {
    try {
        const { email } = req.body;

        if (!email) {
            res.status(400).json({ message: 'Email requis' });
            return;
        }

        const user = await User.findOne({ email, accountStatus: { $ne: 'deleted' } });

        if (!user) {
            // Pour des raisons de sécurité, ne pas indiquer si l'email existe ou non
            res.status(200).json({ message: 'Si cet email est associé à un compte, un lien de réinitialisation sera envoyé' });
            return;
        }

        // Générer un token de réinitialisation
        const resetToken = user.generatePasswordResetToken();
        await user.save();

        // Envoyer l'email
        await sendPasswordResetEmail(user, resetToken);

        res.status(200).json({ message: 'Un lien de réinitialisation a été envoyé à votre adresse email' });
    } catch (error) {
        console.error('Erreur lors de la demande de réinitialisation:', error);
        res.status(500).json({ message: 'Erreur lors de la demande de réinitialisation' });
    }
};

// Réinitialisation du mot de passe
export const resetPassword = async (req: Request, res: Response): Promise<void> => {
    try {
        const { token } = req.params;
        const { password, confirmPassword } = req.body;

        if (!token) {
            res.status(400).json({ message: 'Token de réinitialisation non fourni' });
            return;
        }

        if (!password || !confirmPassword) {
            res.status(400).json({ message: 'Nouveau mot de passe et confirmation requis' });
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

        // Hachage du token pour la comparaison
        const hashedToken = crypto
            .createHash('sha256')
            .update(token)
            .digest('hex');

        // Recherche de l'utilisateur avec ce token
        const user = await User.findOne({
            passwordResetToken: hashedToken,
            passwordResetExpires: { $gt: Date.now() }
        });

        if (!user) {
            res.status(400).json({ message: 'Token invalide ou expiré' });
            return;
        }

        // Mise à jour du mot de passe
        user.password = password;
        user.passwordResetToken = undefined;
        user.passwordResetExpires = undefined;
        await user.save();

        res.status(200).json({ message: 'Mot de passe réinitialisé avec succès. Vous pouvez maintenant vous connecter avec votre nouveau mot de passe.' });
    } catch (error) {
        console.error('Erreur lors de la réinitialisation du mot de passe:', error);
        res.status(500).json({ message: 'Erreur lors de la réinitialisation du mot de passe' });
    }
};

// Envoi d'un code de vérification par SMS
export const sendPhoneVerification = async (req: Request, res: Response): Promise<void> => {
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

        // Valider le numéro de téléphone
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

// Vérification du code SMS
export const verifyPhone = async (req: Request, res: Response): Promise<void> => {
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

        // Validation du numéro de téléphone
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

// Récupération du profil utilisateur
export const getProfile = async (req: Request, res: Response): Promise<void> => {
    try {
        const user = req.user as IUser;

        res.status(200).json({
            user: {
                id: user._id,
                username: user.username,
                email: user.email,
                phoneNumber: user.phoneNumber,
                isEmailVerified: user.isEmailVerified,
                isPhoneVerified: user.isPhoneVerified,
                profilePicture: user.profilePicture,
                createdAt: user.createdAt,
                lastLogin: user.lastLogin,
                socialAuth: {
                    google: user.socialAuth?.google ? true : false,
                    facebook: user.socialAuth?.facebook ? true : false,
                    discord: user.socialAuth?.discord ? true : false
                }
            }
        });
    } catch (error) {
        console.error('Erreur lors de la récupération du profil:', error);
        res.status(500).json({ message: 'Erreur lors de la récupération du profil' });
    }
};

// Mise à jour du profil utilisateur
export const updateProfile = async (req: Request, res: Response): Promise<void> => {
    try {
        // Récupérer l'ID utilisateur depuis le token JWT
        const userId = (req.user as any).id;

        if (!userId) {
            res.status(400).json({ message: 'ID utilisateur non trouvé' });
            return;
        }

        // Récupérer l'utilisateur complet depuis la base de données
        const user = await User.findById(userId);

        if (!user) {
            res.status(404).json({ message: 'Utilisateur non trouvé' });
            return;
        }

        const { username, email } = req.body;

        // Vérification et mise à jour du nom d'utilisateur
        if (username && username !== user.username) {
            const existingUser = await User.findOne({ username });
            if (existingUser) {
                res.status(400).json({ message: 'Ce nom d\'utilisateur est déjà utilisé' });
                return;
            }
            user.username = username;
        }

        // Vérification et mise à jour de l'email
        if (email && email !== user.email) {
            // Valider le format de l'email
            if (!validateEmail(email)) {
                res.status(400).json({ message: 'Format d\'email invalide' });
                return;
            }

            // Vérifier si l'email existe déjà
            const existingUserWithEmail = await User.findOne({ email });
            if (existingUserWithEmail) {
                res.status(400).json({ message: 'Cet email est déjà utilisé par un autre compte' });
                return;
            }

            // Mettre à jour l'email et réinitialiser la vérification
            user.email = email;
            user.isEmailVerified = false;

            // Générer un nouveau token de vérification
            const verificationToken = user.generateVerificationToken();

            // Envoyer un email de vérification pour le nouvel email
            await sendVerificationEmail(user, verificationToken);
        }

        // Enregistrer les modifications
        await user.save();

        res.status(200).json({
            message: email && email !== user.email ?
                'Profil mis à jour avec succès. Veuillez vérifier votre nouvelle adresse email.' :
                'Profil mis à jour avec succès',
            user: {
                id: user._id,
                username: user.username,
                email: user.email,
                isEmailVerified: user.isEmailVerified
            }
        });
    } catch (error) {
        console.error('Erreur lors de la mise à jour du profil:', error);
        res.status(500).json({ message: 'Erreur lors de la mise à jour du profil' });
    }
};

// Modification du mot de passe
export const updatePassword = async (req: Request, res: Response): Promise<void> => {
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

// Suppression de compte
export const deleteAccount = async (req: Request, res: Response): Promise<void> => {
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

        // Invalider le token en l'ajoutant à la blacklist
        const authHeader = req.headers.authorization;
        if (authHeader) {
            const token = authHeader.split(' ')[1];
            if (token) {
                tokenBlacklist.add(token);
            }
        }

        res.status(200).json({ message: 'Votre compte a été supprimé avec succès' });
    } catch (error) {
        console.error('Erreur lors de la suppression du compte:', error);
        res.status(500).json({ message: 'Erreur lors de la suppression du compte' });
    }
};

// Vérification d'authenticité du token pour les middlewares
export const verifyToken = (req: Request, res: Response, next: Function): void => {
    try {
        const authHeader = req.headers.authorization;

        if (!authHeader) {
            res.status(401).json({ message: 'Accès non autorisé. Token manquant.' });
            return;
        }

        const token = authHeader.split(' ')[1];

        if (!token) {
            res.status(401).json({ message: 'Format du token invalide' });
            return;
        }

        // Vérifier si le token est dans la liste noire
        if (tokenBlacklist.has(token)) {
            res.status(401).json({ message: 'Token invalidé. Veuillez vous reconnecter.' });
            return;
        }

        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET || 'default_jwt_secret');
            (req as any).user = decoded;

            next();
        } catch (error: unknown) {
            // Gérer les erreurs spécifiques aux tokens
            const tokenError = error as { name?: string };
            if (tokenError.name === 'TokenExpiredError') {
                res.status(401).json({ message: 'Token expiré. Veuillez vous reconnecter.' });
            } else {
                res.status(401).json({ message: 'Token invalide. Veuillez vous reconnecter.' });
            }
        }
    } catch (error) {
        console.error('Erreur lors de la vérification du token:', error);
        res.status(500).json({ message: 'Erreur interne du serveur.' });
    }
};

// Callback pour les authentifications sociales
export const socialAuthCallback = async (req: Request, res: Response): Promise<void> => {
    try {
        const user = req.user as IUser;

        if (!user) {
            res.status(401).json({ message: 'Authentification échouée' });
            return;
        }

        // Mise à jour de la date de dernière connexion
        user.lastLogin = new Date();
        await user.save();

        const token = generateToken(user);

        // Redirection avec token vers le frontend ou réponse JSON selon les besoins
        if (req.query.redirect) {
            res.redirect(`${req.query.redirect}?token=${token}`);
        } else {
            res.status(200).json({
                message: 'Connexion réussie',
                token,
                user: {
                    id: user._id,
                    username: user.username,
                    email: user.email
                }
            });
        }
    } catch (error) {
        console.error('Erreur lors de l\'authentification sociale:', error);
        res.status(500).json({ message: 'Erreur lors de l\'authentification sociale' });
    }
};

function validatePhoneNumber(phoneNumber: string): boolean {
    // Simple regex to validate phone numbers
    // Accepts formats like: +1234567890, 1234567890, 123-456-7890
    const phoneRegex = /^(\+\d{1,3})?[-.\s]?\(?\d{1,4}\)?[-.\s]?\d{1,4}[-.\s]?\d{1,9}$/;
    return phoneRegex.test(phoneNumber);
}
