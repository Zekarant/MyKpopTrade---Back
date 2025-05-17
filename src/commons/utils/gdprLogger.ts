import logger from './logger';
import { EncryptionService } from './encryptionService';
import User from '../../models/userModel';

/**
 * Logger compatible RGPD qui masque les données sensibles
 */
export class GdprLogger {
  /**
   * Liste des champs sensibles à masquer automatiquement
   */
  private static sensitiveFields = [
    'password', 'cardNumber', 'cvv', 'expiryDate', 'accountNumber',
    'ssn', 'email', 'phone', 'address', 'ipAddress', 'userAgent',
    'dateOfBirth', 'firstName', 'lastName'
  ];

  private static requestCounts: Map<string, { count: number, firstSeen: Date }> = new Map();
  private static readonly THRESHOLD = 20;
  private static readonly TIME_WINDOW_MS = 3600000; // 1 heure

  /**
   * Journalise une action liée au paiement en respectant les principes RGPD
   */
  static logPaymentAction(action: string, data: any, userId: string): void {
    // Créer une copie des données pour éviter la modification de l'original
    const sanitizedData = this.sanitizeData({ ...data });
    
    // Pseudonymiser l'ID utilisateur
    const pseudonymizedUserId = this.pseudonymizeId(userId);
    
    logger.info(`Action de paiement: ${action}`, {
      userId: pseudonymizedUserId,
      ...sanitizedData,
      timestamp: new Date().toISOString()
    });
  }
  
  /**
   * Journalise une erreur liée au paiement
   */
  static logPaymentError(error: any, userId: string, context: any = {}): void {
    const sanitizedContext = this.sanitizeData({ ...context });
    
    // Pseudonymiser l'ID utilisateur
    const pseudonymizedUserId = this.pseudonymizeId(userId);
    
    logger.error('Erreur de paiement', {
      userId: pseudonymizedUserId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      context: sanitizedContext,
      timestamp: new Date().toISOString()
    });
  }
  
  /**
   * Journalise un accès aux données de paiement (audit)
   */
  static logPaymentDataAccess(action: string, dataId: string, accessedBy: string, reason?: string): void {
    logger.info(`Accès aux données de paiement: ${action}`, {
      dataId,
      accessedBy: this.pseudonymizeId(accessedBy),
      reason,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Journalise une erreur générale en respectant les principes RGPD
   * @param message Message d'erreur
   * @param error Objet d'erreur
   * @param context Contexte supplémentaire
   */
  static logError(message: string, error: any, context: any = {}): void {
    const sanitizedContext = this.sanitizeData({ ...context });
    
    logger.error(message, {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      context: sanitizedContext,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Journalise une information générale en respectant les principes RGPD
   * @param message Message d'information
   * @param context Contexte supplémentaire
   */
  static logInfo(message: string, context: any = {}): void {
    const sanitizedContext = this.sanitizeData({ ...context });
    
    logger.info(message, {
      context: sanitizedContext,
      timestamp: new Date().toISOString()
    });
  }
  
  /**
   * Sanitise les données en masquant les informations sensibles
   */
  private static sanitizeData(data: any): any {
    if (!data) return data;
    
    if (typeof data !== 'object') return data;
    
    // Pour les tableaux, traiter chaque élément
    if (Array.isArray(data)) {
      return data.map(item => this.sanitizeData(item));
    }
    
    // Pour les objets, traiter chaque propriété
    const result: any = {};
    
    for (const [key, value] of Object.entries(data)) {
      // Si la clé contient un champ sensible
      if (this.sensitiveFields.some(field => key.toLowerCase().includes(field.toLowerCase()))) {
        result[key] = typeof value === 'string' ? 
          EncryptionService.anonymize(value as string) : '***MASQUÉ***';
      }
      // Si la valeur est un objet, récursion
      else if (value && typeof value === 'object') {
        result[key] = this.sanitizeData(value);
      }
      // Sinon, garder la valeur
      else {
        result[key] = value;
      }
    }
    
    return result;
  }
  
  /**
   * Pseudonymise un identifiant utilisateur
   */
  private static pseudonymizeId(id: string): string {
    if (!id) return 'anonymous';
    return id.substring(0, 3) + '...' + id.substring(id.length - 3);
  }

  /**
   * Vérifie les tentatives excessives d'accès aux données
   * @param userId ID de l'utilisateur faisant la requête
   * @param resourceType Type de ressource accédée
   * @param ip Adresse IP
   * @returns true si un seuil d'alerte est atteint
   */
  static checkSuspiciousActivity(userId: string, resourceType: string, ip: string): boolean {
    // Créer une empreinte unique pour cette combinaison d'utilisateur et d'IP
    const key = EncryptionService.generateTransactionHash(`${userId}:${ip}:${resourceType}`, Date.now());
    
    const now = new Date();
    const record = this.requestCounts.get(key);
    
    if (!record) {
      this.requestCounts.set(key, { count: 1, firstSeen: now });
      return false;
    }
    
    // Réinitialiser le compteur si en dehors de la fenêtre de temps
    if (now.getTime() - record.firstSeen.getTime() > this.TIME_WINDOW_MS) {
      this.requestCounts.set(key, { count: 1, firstSeen: now });
      return false;
    }
    
    // Incrémenter le compteur
    record.count += 1;
    this.requestCounts.set(key, record);
    
    // Vérifier si le seuil est dépassé
    if (record.count > this.THRESHOLD) {
      this.reportSuspiciousActivity(userId, resourceType, ip, record.count);
      return true;
    }
    
    return false;
  }

  /**
   * Signale une activité suspecte potentielle
   */
  private static reportSuspiciousActivity(userId: string, resourceType: string, ip: string, count: number): void {
    // Masquer l'IP avant de la journaliser
    const maskedIP = EncryptionService.anonymize(ip);
    
    logger.warn('Activité suspecte détectée - Possible violation de données', {
      userId: this.pseudonymizeId(userId),
      resourceType,
      ipHash: maskedIP,
      requestCount: count,
      timestamp: new Date().toISOString()
    });
    
    // Si une adresse email est configurée pour les alertes de sécurité, envoyer un email
    this.sendSecurityAlert(userId, resourceType, count);
  }

  /**
   * Envoie une alerte de sécurité par email au DPO
   */
  private static async sendSecurityAlert(userId: string, resourceType: string, requestCount: number): Promise<void> {
    if (process.env.DATA_PROTECTION_EMAIL) {
      try {
        const user = await User.findById(userId).select('email username');
        const emailService = require('../services/emailService');
        
        await emailService.sendEmail({
          to: process.env.DATA_PROTECTION_EMAIL,
          subject: 'ALERTE - Activité suspecte détectée',
          html: `
            <p>Une activité suspecte a été détectée:</p>
            <ul>
              <li>Ressource: ${resourceType}</li>
              <li>Nombre de requêtes: ${requestCount} en moins d'une heure</li>
              <li>Utilisateur: ${user ? user.username : userId} (${user ? user.email : 'Email inconnu'})</li>
              <li>Horodatage: ${new Date().toISOString()}</li>
            </ul>
            <p>Cette alerte a été générée automatiquement conformément au RGPD Article 33.
            Une enquête est recommandée pour déterminer s'il s'agit d'une violation de données à notifier.</p>
          `
        });
      } catch (error) {
        logger.error('Échec de l\'envoi de l\'alerte de violation par email', {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }
}