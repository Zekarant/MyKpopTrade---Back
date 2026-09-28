import cron from 'node-cron';
import { eraseAccountsDueForDeletion } from '../../modules/users/services/accountErasureService';
import logger from '../utils/logger';

/**
 * Chaque nuit à 3h30 : efface les comptes dont la suppression demandée arrive
 * au terme du délai de 30 jours. La politique de confidentialité le promet ;
 * sans cette tâche, rien ne se passait tant qu'un admin n'intervenait pas.
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
