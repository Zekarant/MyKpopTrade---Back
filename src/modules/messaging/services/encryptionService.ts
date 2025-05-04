import crypto from 'crypto';
import logger from '../../../commons/utils/logger';

// Clé utilisée pour le chiffrement des messages (à configurer via variables d'environnement)
const MESSAGE_ENCRYPTION_KEY = process.env.MESSAGE_ENCRYPTION_KEY || '';

// Valider la clé au démarrage
if (!MESSAGE_ENCRYPTION_KEY) {
  logger.error('Attention: MESSAGE_ENCRYPTION_KEY n\'est pas configurée. La sécurité des messages pourrait être compromise.');
}

/**
 * Chiffre le contenu d'un message
 * @param content Contenu du message en clair
 * @returns Objet contenant le message chiffré et les détails de chiffrement
 */
export const encryptMessage = (content: string): {
  encryptedContent: string;
  algorithm: string;
  iv: string;
} => {
  try {
    // Utiliser un vecteur d'initialisation unique pour chaque message
    const iv = crypto.randomBytes(16);
    const algorithm = 'aes-256-cbc';
    
    // Créer la clé de chiffrement à partir de la clé brute
    const key = crypto
      .createHash('sha256')
      .update(MESSAGE_ENCRYPTION_KEY)
      .digest();
    
    // Chiffrer le contenu
    const cipher = crypto.createCipheriv(algorithm, key, iv);
    let encryptedContent = cipher.update(content, 'utf8', 'hex');
    encryptedContent += cipher.final('hex');
    
    return {
      encryptedContent,
      algorithm,
      iv: iv.toString('hex')
    };
  } catch (error) {
    logger.error('Erreur lors du chiffrement du message', { error });
    throw new Error('Impossible de chiffrer le message');
  }
};

/**
 * Déchiffre le contenu d'un message
 * @param encryptedContent Contenu chiffré du message
 * @param algorithm Algorithme utilisé pour le chiffrement
 * @param iv Vecteur d'initialisation utilisé pour le chiffrement
 * @returns Contenu déchiffré du message
 */
export const decryptMessage = (
  encryptedContent: string,
  algorithm: string,
  iv: string
): string => {
  try {
    // Recréer la clé de chiffrement
    const key = crypto
      .createHash('sha256')
      .update(MESSAGE_ENCRYPTION_KEY)
      .digest();
    
    // Convertir le vecteur d'initialisation en Buffer
    const ivBuffer = Buffer.from(iv, 'hex');
    
    // Déchiffrer le contenu
    const decipher = crypto.createDecipheriv(algorithm, key, ivBuffer);
    let decryptedContent = decipher.update(encryptedContent, 'hex', 'utf8');
    decryptedContent += decipher.final('utf8');
    
    return decryptedContent;
  } catch (error) {
    logger.error('Erreur lors du déchiffrement du message', { error });
    throw new Error('Impossible de déchiffrer le message');
  }
};