import cron from 'node-cron';
import { anonymizeExpiredPayments } from '../../modules/payments/services/paymentAnonymizationService';
import { GdprLogger } from '../utils/gdprLogger';

/**
 * Tâche d'anonymisation automatique des vieux paiements (RGPD)
 * S'exécute une fois par semaine (le dimanche à 3h du matin)
 */
export const startGdprCleanupTask = () => {
  cron.schedule('0 3 * * 0', async () => {
    try {
      GdprLogger.logInfo('Démarrage de la tâche d\'anonymisation GDPR', {});

      const count = await anonymizeExpiredPayments();

      GdprLogger.logInfo('Anonymisation périodique des données de paiement terminée', {
        count,
        operation: 'scheduled_gdpr_cleanup'
      });
    } catch (error) {
      GdprLogger.logError('Erreur lors de l\'anonymisation automatique des données', error);
    }
  }, {
    timezone: 'Europe/Paris',
    noOverlap: true
  });

  GdprLogger.logInfo('Tâche d\'anonymisation GDPR programmée', {
    schedule: '0 3 * * 0',
    timezone: 'Europe/Paris'
  });
};
