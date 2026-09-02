import crypto from 'crypto';
import env from '../../config/env';

const ENCRYPTION_KEY = env.ENCRYPTION_KEY;

/** AES-256 exige une clé de 32 octets et un IV de 16 octets. */
const KEY_BYTES = 32;
const IV_BYTES = 16;

/**
 * Préfixe marquant le format actuel : `v2:<iv hex>:<chiffré hex>`.
 *
 * Le format d'origine réutilisait un IV FIXE lu dans `ENCRYPTION_IV`, ce qui
 * rendait le chiffrement déterministe : deux valeurs identiques produisaient le
 * même chiffré, révélant leur égalité à qui lit la base. Le nouveau format tire
 * un IV aléatoire par opération. Le déchiffrement reconnaît les deux formats
 * pour que les données déjà en base restent lisibles.
 */
const CURRENT_FORMAT_PREFIX = 'v2';

/** IV historique, uniquement pour déchiffrer les données antérieures. */
const legacyIv = (): Buffer | null => {
  const raw = process.env.ENCRYPTION_IV;
  if (!raw || raw.length < IV_BYTES) return null;
  return Buffer.from(raw.slice(0, IV_BYTES), 'utf8');
};

/**
 * Clé de chiffrement, résolue à l'appel et non à l'import.
 *
 * `ENCRYPTION_KEY` est obligatoire en production (cf. config/env.ts) mais
 * optionnelle ailleurs : vérifier à l'import ferait échouer le chargement du
 * module dans les tests qui ne chiffrent rien. L'erreur est donc levée au
 * premier usage réel, avec un message actionnable.
 */
const encryptionKey = (): Buffer => {
  if (!ENCRYPTION_KEY) {
    throw new Error(
      'ENCRYPTION_KEY est requise pour chiffrer ou déchiffrer des données personnelles. ' +
      'Générer une clé de 32 caractères minimum : openssl rand -hex 32'
    );
  }
  return Buffer.from(ENCRYPTION_KEY.slice(0, KEY_BYTES), 'utf8');
};

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
      
      // IV aléatoire par opération, transporté avec le chiffré.
      const iv = crypto.randomBytes(IV_BYTES);

      const cipher = crypto.createCipheriv('aes-256-cbc', encryptionKey(), iv);
      let encrypted = cipher.update(dataString, 'utf8', 'hex');
      encrypted += cipher.final('hex');

      return `${CURRENT_FORMAT_PREFIX}:${iv.toString('hex')}:${encrypted}`;
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
      const parts = encryptedData.split(':');
      let iv: Buffer;
      let payload: string;

      if (parts.length === 3 && parts[0] === CURRENT_FORMAT_PREFIX) {
        iv = Buffer.from(parts[1], 'hex');
        payload = parts[2];
      } else {
        // Format historique : IV fixe issu de l'environnement.
        const fallbackIv = legacyIv();
        if (!fallbackIv) {
          throw new Error(
            "Donnée chiffrée au format historique mais ENCRYPTION_IV n'est plus configurée : impossible de la déchiffrer."
          );
        }
        iv = fallbackIv;
        payload = encryptedData;
      }

      const decipher = crypto.createDecipheriv('aes-256-cbc', encryptionKey(), iv);
      let decrypted = decipher.update(payload, 'hex', 'utf8');
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