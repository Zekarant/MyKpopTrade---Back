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
    
    // Si c'est un email
    if (value.includes('@')) {
      const [name, domain] = value.split('@');
      return `${name.charAt(0)}${'*'.repeat(Math.max(name.length - 2, 2))}${name.charAt(name.length - 1)}@${domain}`;
    }
    
    // Si c'est un numéro de téléphone
    if (/^\+?[0-9\s-]{8,}$/.test(value)) {
      return `${'*'.repeat(value.length - 4)}${value.slice(-4)}`;
    }
    
    // Si c'est une chaîne courte (comme un nom), préserver première et dernière lettre
    if (value.length < 12) {
      return `${value.charAt(0)}${'*'.repeat(Math.max(value.length - 2, 1))}${value.charAt(value.length - 1)}`;
    }
    
    // Pour les chaînes longues, masquer le milieu
    return `${value.substring(0, 3)}${'*'.repeat(Math.max(value.length - 6, 3))}${value.substring(value.length - 3)}`;
  }
}