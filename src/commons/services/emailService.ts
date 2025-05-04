import nodemailer from 'nodemailer';
import { IUser } from '../../models/userModel';
import dotenv from 'dotenv';

dotenv.config();

const BASE_URL = process.env.FRONTEND_URL || 'http://localhost:8080';
const FROM_EMAIL = process.env.FROM_EMAIL || 'noreply@mykpoptrade.com';

// Création du transporteur d'emails
const createTransporter = async () => {
  // En développement, créer un compte Ethereal temporaire
  if (process.env.NODE_ENV !== 'production') {
    const testAccount = await nodemailer.createTestAccount();
    
    console.log('Compte Ethereal créé:');
    console.log('- Email:', testAccount.user);
    console.log('- Mot de passe:', testAccount.pass);
    console.log('- URL de prévisualisation: https://ethereal.email');

    return nodemailer.createTransport({
      host: 'smtp.ethereal.email',
      port: 587,
      secure: false,
      auth: {
        user: testAccount.user,
        pass: testAccount.pass,
      },
    });
  } else {
    return nodemailer.createTransport({
      service: process.env.EMAIL_SERVICE,
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });
  }
};

/**
 * Envoie un email de vérification à l'utilisateur
 */
export const sendVerificationEmail = async (user: IUser, token: string): Promise<void> => {
  const verificationUrl = `${BASE_URL}/verify-email/${token}`;
  
  const transporter = await createTransporter();
  
  const mailOptions = {
    from: `"MyKpopTrade" <${FROM_EMAIL}>`,
    to: user.email,
    subject: 'Vérification de votre adresse email',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Bienvenue sur MyKpopTrade !</h2>
        <p>Bonjour ${user.username},</p>
        <p>Merci de vous être inscrit(e) sur MyKpopTrade. Pour activer votre compte, veuillez cliquer sur le lien ci-dessous :</p>
        <p>
          <a href="${verificationUrl}" style="display: inline-block; background-color: #4CAF50; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">
            Vérifier mon adresse email
          </a>
        </p>
        <p>Ce lien expirera dans 24 heures.</p>
        <p>Si vous n'avez pas créé de compte sur MyKpopTrade, vous pouvez ignorer cet email.</p>
        <p>Cordialement,<br/>L'équipe MyKpopTrade</p>
      </div>
    `
  };

  const info = await transporter.sendMail(mailOptions);
  
  if (process.env.NODE_ENV !== 'production') {
    console.log('URL de prévisualisation de l\'email:', nodemailer.getTestMessageUrl(info));
  }
};

/**
 * Envoie un email de réinitialisation de mot de passe
 */
export const sendPasswordResetEmail = async (user: IUser, token: string): Promise<void> => {
  const resetUrl = `${BASE_URL}/reset-password/${token}`;
  
  const transporter = await createTransporter();
  
  const mailOptions = {
    from: `"MyKpopTrade" <${FROM_EMAIL}>`,
    to: user.email,
    subject: 'Réinitialisation de votre mot de passe',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Réinitialisation de mot de passe</h2>
        <p>Bonjour ${user.username},</p>
        <p>Vous avez demandé une réinitialisation de mot de passe. Cliquez sur le lien ci-dessous pour créer un nouveau mot de passe :</p>
        <p>
          <a href="${resetUrl}" style="display: inline-block; background-color: #2196F3; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">
            Réinitialiser mon mot de passe
          </a>
        </p>
        <p>Ce lien expirera dans 1 heure.</p>
        <p>Si vous n'avez pas demandé cette réinitialisation, vous pouvez ignorer cet email.</p>
        <p>Cordialement,<br/>L'équipe MyKpopTrade</p>
      </div>
    `
  };

  const info = await transporter.sendMail(mailOptions);
  
  if (process.env.NODE_ENV !== 'production') {
    console.log('URL de prévisualisation de l\'email:', nodemailer.getTestMessageUrl(info));
  }
};

/**
 * Envoie un email de confirmation de suppression de compte
 */
export const sendAccountDeletionEmail = async (user: IUser): Promise<void> => {
  const transporter = await createTransporter();
  
  const mailOptions = {
    from: `"MyKpopTrade" <${FROM_EMAIL}>`,
    to: user.email,
    subject: 'Confirmation de suppression de compte',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Votre compte a été supprimé</h2>
        <p>Bonjour ${user.username},</p>
        <p>Nous vous confirmons que votre compte a été supprimé de notre service.</p>
        <p>Nous regrettons de vous voir partir et espérons vous revoir bientôt !</p>
        <p>Si cette action a été faite par erreur, veuillez nous contacter rapidement à support@mykpoptrade.com.</p>
        <p>Cordialement,<br/>L'équipe MyKpopTrade</p>
      </div>
    `
  };

  const info = await transporter.sendMail(mailOptions);
  
  if (process.env.NODE_ENV !== 'production') {
    console.log('URL de prévisualisation de l\'email:', nodemailer.getTestMessageUrl(info));
  }
};