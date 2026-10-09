import cron from 'node-cron';
import { expireStaleVerifications } from '../../modules/verification/services/identityVerificationService';
import logger from '../utils/logger';

/**
 * Chaque nuit à 4h : clôt les demandes de vérification d'identité échues et
 * supprime les pièces d'identité expirées (conservation limitée, RGPD).
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
  }, { noOverlap: true });
};
