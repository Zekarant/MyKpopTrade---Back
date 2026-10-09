import cron from 'node-cron';
import logger from '../utils/logger';
import { flushDueSavedSearchAlerts } from '../../modules/savedSearches/alertService';

/** Un quart d'heure : une alerte regroupée part au plus 15 min après la fin de son délai. */
const FLUSH_SCHEDULE = '*/15 * * * *';

/**
 * Envoie les alertes de recherches sauvegardées regroupées pendant le délai
 * d'une heure et qu'aucune nouvelle annonce n'est venue déclencher.
 * `noOverlap` : un passage lent ne doit pas être doublé par le suivant.
 */
export const startSavedSearchAlertTask = () => {
  cron.schedule(FLUSH_SCHEDULE, async () => {
    try {
      const sent = await flushDueSavedSearchAlerts();
      if (sent > 0) logger.info('Alertes de recherches sauvegardées envoyées', { sent });
    } catch (error) {
      logger.error('Erreur cron alertes de recherches sauvegardées', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }, { timezone: 'Europe/Paris', noOverlap: true });
};
