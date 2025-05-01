import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

const createTransporter = async () => {
  // En développement, créer un compte Ethereal temporaire
  if (process.env.NODE_ENV !== 'production') {
    // Créer un compte de test
    const testAccount = await nodemailer.createTestAccount();
    
    console.log('Compte Ethereal créé:');
    console.log('- Email:', testAccount.user);
    console.log('- Mot de passe:', testAccount.pass);
    console.log('- URL de prévisualisation: https://ethereal.email');

    // Créer un transporteur avec les identifiants du compte de test
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
    // En production, utiliser les variables d'environnement
    return nodemailer.createTransport({
      service: process.env.EMAIL_SERVICE,
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });
  }
};

// Exporter une fonction qui retourne un transporteur
export const getEmailTransporter = async () => {
  return await createTransporter();
};