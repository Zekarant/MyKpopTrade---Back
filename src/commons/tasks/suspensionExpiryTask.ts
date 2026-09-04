import cron from 'node-cron';
import { liftExpiredSuspensions } from '../../modules/users/services/userSanctionService';
import logger from '../utils/logger';

export const startSuspensionExpiryTask = () => {
  cron.schedule('5 * * * *', async () => {
    try {
      await liftExpiredSuspensions();
    } catch (error) {
      logger.error('Échec de la levée automatique des suspensions', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });
};
