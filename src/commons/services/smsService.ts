import twilio from 'twilio';
import dotenv from 'dotenv';

dotenv.config();

// Configuration Twilio
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const fromPhoneNumber = process.env.TWILIO_PHONE_NUMBER;
const smsEnabled = process.env.SMS_ENABLED === 'true';

// Client Twilio (seulement si la configuration est disponible)
const client = smsEnabled && accountSid && authToken ? 
  twilio(accountSid, authToken) : 
  null;

/**
 * Envoie un SMS de vérification via Twilio
 * @param phoneNumber Numéro de téléphone destinataire
 * @param code Code de vérification à 6 chiffres
 */
export const sendVerificationSMS = async (phoneNumber: string, code: string): Promise<void> => {
  const message = `Votre code de vérification MyKpopTrade est : ${code}`;
  
  if (smsEnabled && client && fromPhoneNumber) {
    try {
      const result = await client.messages.create({
        body: message,
        from: fromPhoneNumber,
        to: phoneNumber
      });
      console.log(`SMS envoyé avec succès, SID: ${result.sid}`);
    } catch (error) {
      console.error('Erreur lors de l\'envoi du SMS:', error);
      throw new Error('Impossible d\'envoyer le SMS. Veuillez réessayer plus tard.');
    }
  } else {
    // Mode développement - simulation d'envoi
    console.log(`[SIMULATION SMS] À: ${phoneNumber} - Message: ${message}`);
  }
};

/**
 * Génère un code de vérification à 6 chiffres
 */
export const generateVerificationCode = (): string => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};