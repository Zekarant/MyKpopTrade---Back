import cron from 'node-cron';
import { expireStaleVerifications } from '../../modules/verification/services/identityVerificationService';
import logger from '../utils/logger';

/**
 * Chaque nuit à 4h : clôt les demandes de vérification d'identité restées sans
 * examen au-delà de leur échéance et supprime les pièces d'identité expirées.
 * La politique de confidentialité promet une conservation limitée ; sans cette
 * tâche, les documents restaient stockés indéfiniment.
 */
export const startIdentityDocumentCleanupTask = () => {
  cron.schedule('0 4 * * *', async () => {
    try {
      await expireStaleVerifications();
    } catch (error) {
      logger.error('Échec du nettoyage des pièces d\'identité expirées', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });
};
