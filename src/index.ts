import mongoose from 'mongoose';
import app from './app';
import env from './config/env';
import logger from './commons/utils/logger';
import { startGdprCleanupTask } from './commons/tasks/gdprCleanupTask';
import { startShipmentTrackingTask } from './commons/tasks/shipmentTrackingTask';
import { startReservationCleanupTask } from './commons/tasks/reservationCleanupTask';
import { startSuspensionExpiryTask } from './commons/tasks/suspensionExpiryTask';
import { startIdentityDocumentCleanupTask } from './commons/tasks/identityDocumentCleanupTask';
import { startAccountDeletionTask } from './commons/tasks/accountDeletionTask';

if (process.env.NODE_ENV !== 'test') {
  startGdprCleanupTask();
  startShipmentTrackingTask();
  startReservationCleanupTask();
  startSuspensionExpiryTask();
  startIdentityDocumentCleanupTask();
  startAccountDeletionTask();
  logger.info('Tâches CRON de maintenance démarrées');
}

mongoose.connect(env.MONGODB_URI)
  .then(() => {
    // Jamais l'URI complète : elle contient les identifiants de la base.
    logger.info('Connecté à MongoDB');

    app.listen(env.PORT, () => {
      logger.info(`Serveur démarré sur le port ${env.PORT} en mode ${env.NODE_ENV}`);
      logger.info(`API URL: ${env.API_URL}`);
      logger.info(`Frontend URL: ${env.FRONTEND_URL}`);
    });
  })
  .catch((error) => {
    logger.error('Erreur de connexion à MongoDB:', error);
    process.exit(1);
  });

export default app;
