import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

// Récupérer les clés depuis les variables d'environnement
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '';
const ENCRYPTION_IV = process.env.ENCRYPTION_IV || '';

if (!ENCRYPTION_KEY || !ENCRYPTION_IV || ENCRYPTION_KEY.length < 32 || ENCRYPTION_IV.length < 16) {
  throw new Error('Les clés de chiffrement ne sont pas correctement configurées');
}

/**
 * Service de chiffrement pour les données sensibles (conforme RGPD)
 */
export class EncryptionService {
  /**
   * Chiffre des données
   * @param data Données à chiffrer
   * @returns Données chiffrées sous forme de chaîne
   */
  static encrypt(data: any): string {
    try {
      // Convertir les données en chaîne JSON si nécessaire
      const dataString = typeof data === 'object' ? JSON.stringify(data) : String(data);
      
      // Utiliser les 32 premiers caractères de la clé et les 16 premiers caractères de l'IV
      const key = Buffer.from(ENCRYPTION_KEY.slice(0, 32), 'utf8');
      const iv = Buffer.from(ENCRYPTION_IV.slice(0, 16), 'utf8');
      
      const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
      let encrypted = cipher.update(dataString, 'utf8', 'hex');
      encrypted += cipher.final('hex');
      
      return encrypted;
    } catch (error) {
      console.error('Erreur lors du chiffrement:', error);
      throw new Error('Erreur lors du chiffrement des données');
    }
  }
  
  /**
   * Déchiffre des données
   * @param encryptedData Données chiffrées
   * @returns Données déchiffrées
   */
  static decrypt(encryptedData: string): any {
    try {
      // Utiliser les 32 premiers caractères de la clé et les 16 premiers caractères de l'IV
      const key = Buffer.from(ENCRYPTION_KEY.slice(0, 32), 'utf8');
      const iv = Buffer.from(ENCRYPTION_IV.slice(0, 16), 'utf8');
      
      const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
      let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      
      // Tenter de parser en JSON si possible
      try {
        return JSON.parse(decrypted);
      } catch {
        return decrypted;
      }
    } catch (error) {
      console.error('Erreur lors du déchiffrement:', error);
      throw new Error('Erreur lors du déchiffrement des données');
    }
  }
  
  /**
   * Génère un hash pour les identifiants de transaction
   */
  static generateTransactionHash(userId: string, timestamp: number): string {
    return crypto
      .createHash('sha256')
      .update(`${userId}-${timestamp}-${Math.random()}`)
      .digest('hex');
  }
  
  /**
   * Anonymise des données sensibles (conformité RGPD)
   * @param value Valeur à anonymiser
   * @returns Version anonymisée de la valeur
   */
  static anonymize(value: string): string {
    if (!value) return '';
    
    // Pour les adresses email
    if (value.includes('@')) {
      const parts = value.split('@');
      const name = parts[0];
      const domain = parts[1];
      
      // Garder les 2 premiers et derniers caractères du nom
      let maskedName = '';
      if (name.length <= 4) {
        maskedName = name[0] + '*'.repeat(name.length - 1);
      } else {
        maskedName = name.substring(0, 2) + 
                   '*'.repeat(name.length - 4) + 
                   name.substring(name.length - 2);
      }
      
      return `${maskedName}@${domain}`;
    }
    
    // Pour les numéros de téléphone
    if (/^\+?[\d\s\-()]{6,}$/.test(value)) {
      return value.substring(0, 4) + '*'.repeat(value.length - 7) + value.substring(value.length - 3);
    }
    
    // Pour les autres valeurs sensibles (numéro de carte, etc.)
    if (value.length > 6) {
      return value.substring(0, 2) + '*'.repeat(value.length - 4) + value.substring(value.length - 2);
    }
    
    // Si la valeur est trop courte, masquer tout sauf le premier caractère
    return value[0] + '*'.repeat(value.length - 1);
  }
}