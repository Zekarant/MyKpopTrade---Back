import cron from 'node-cron';
import { eraseAccountsDueForDeletion } from '../../modules/users/services/accountErasureService';
import logger from '../utils/logger';

/**
 * Chaque nuit à 3h30 : efface les comptes arrivés au terme du délai de
 * suppression de 30 jours promis par la politique de confidentialité.
 */
export const startAccountDeletionTask = () => {
  cron.schedule('30 3 * * *', async () => {
    try {
      const count = await eraseAccountsDueForDeletion();
      if (count > 0) logger.info('Suppressions de compte programmées exécutées', { count });
    } catch (error) {
      logger.error('Échec des suppressions de compte programmées', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }, { timezone: 'Europe/Paris' });
};
