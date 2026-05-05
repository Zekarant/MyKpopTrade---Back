import cron from 'node-cron';
import logger from '../utils/logger';
import {
  pollPendingShipments,
  autoConfirmStaleShipments,
  sendStuckShipmentReminders
} from '../../modules/payments/services/shipmentService';

/**
 * Planifie les tâches d'automatisation du tracking :
 *  - Polling carrier toutes les 6h sur les colis en transit (no-op tant
 *    qu'aucun TrackingProvider externe n'est branché — le scaffolding est
 *    en place pour AfterShip / EasyPost / La Poste).
 *  - Auto-confirmation et relances quotidiennes à 4h du matin pour
 *    minimiser la concurrence avec le trafic utilisateur.
 *
 * Chaque tâche absorbe ses propres erreurs ; un échec ne décale pas la
 * suivante et ne tue pas le scheduler.
 */
export const startShipmentTrackingTask = () => {
  // Polling carrier — toutes les 6h
  cron.schedule('0 */6 * * *', async () => {
    try {
      await pollPendingShipments();
    } catch (error) {
      logger.error('Erreur cron polling shipments', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }, { timezone: 'Europe/Paris' });

  // Auto-confirmation + relances — chaque jour à 4h
  cron.schedule('0 4 * * *', async () => {
    try {
      await autoConfirmStaleShipments();
    } catch (error) {
      logger.error('Erreur cron auto-confirmation shipments', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
    try {
      await sendStuckShipmentReminders();
    } catch (error) {
      logger.error('Erreur cron relances shipments', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }, { timezone: 'Europe/Paris' });

  logger.info('Tâches CRON shipment tracking programmées', {
    polling: '0 */6 * * *',
    autoConfirmAndReminders: '0 4 * * *',
    timezone: 'Europe/Paris'
  });
};
