import logger from './logger';
import { EncryptionService } from './encryptionService';

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
}