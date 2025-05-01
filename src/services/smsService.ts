import dotenv from 'dotenv';
// Dans un environnement de production, vous utiliseriez un service comme Twilio ou Vonage (Nexmo)
// import twilio from 'twilio';

dotenv.config();

// Pour le développement, nous allons simuler l'envoi de SMS
export const sendVerificationSMS = async (phoneNumber: string, code: string): Promise<void> => {
  if (process.env.NODE_ENV === 'production') {
    // Code pour un service réel de SMS
    // const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    // await client.messages.create({
    //   body: `Votre code de vérification MyKpopTrade est : ${code}`,
    //   from: process.env.TWILIO_PHONE_NUMBER,
    //   to: phoneNumber
    // });
    console.log(`Envoi de SMS à ${phoneNumber} avec le code ${code}`);
  } else {
    // En développement, nous affichons simplement le code dans la console
    console.log(`[SIMULATION SMS] À: ${phoneNumber} - Votre code de vérification MyKpopTrade est : ${code}`);
  }
};

// Générer un code de vérification à 6 chiffres
export const generateVerificationCode = (): string => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};