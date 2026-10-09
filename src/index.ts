import type { Server } from 'http';
import mongoose from 'mongoose';
import cron from 'node-cron';
import { createApp } from './app';
import env from './config/env';
import logger from './commons/utils/logger';
import { createShutdownHandler } from './commons/utils/gracefulShutdown';
import { startGdprCleanupTask } from './commons/tasks/gdprCleanupTask';
import { startShipmentTrackingTask } from './commons/tasks/shipmentTrackingTask';
import { startSuspensionExpiryTask } from './commons/tasks/suspensionExpiryTask';
import { startIdentityDocumentCleanupTask } from './commons/tasks/identityDocumentCleanupTask';
import { startAccountDeletionTask } from './commons/tasks/accountDeletionTask';

/**
 * Délai laissé aux requêtes en cours avant sortie forcée. Inférieur aux 30 s
 * de grâce par défaut de Docker / Kubernetes avant SIGKILL.
 */
const SHUTDOWN_TIMEOUT_MS = 10_000;

// Une promesse rejetée sans catch est un bug, mais le process reste cohérent :
// on la journalise au lieu de laisser Node l'afficher hors du logger.
process.on('unhandledRejection', (reason) => {
  logger.error('Promesse rejetée non gérée', {
    error: reason instanceof Error ? reason.stack : String(reason)
  });
});

// Après une exception non capturée, l'état du process est indéterminé :
// on journalise puis on sort, l'orchestrateur redémarre une instance saine.
process.on('uncaughtException', (error) => {
  logger.error('Exception non capturée', { error: error.stack });
  process.exit(1);
});

function startMaintenanceTasks(): void {
  startGdprCleanupTask();
  startShipmentTrackingTask();
  startSuspensionExpiryTask();
  startIdentityDocumentCleanupTask();
  startAccountDeletionTask();
  logger.info('Tâches CRON de maintenance démarrées');
}

async function stopScheduledTasks(): Promise<void> {
  await Promise.all([...cron.getTasks().values()].map((task) => task.stop()));
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function start(): Promise<void> {
  await mongoose.connect(env.MONGODB_URI, {
    maxPoolSize: env.MONGODB_MAX_POOL_SIZE,
    serverSelectionTimeoutMS: env.MONGODB_SERVER_SELECTION_TIMEOUT_MS
  });
  // Jamais l'URI complète : elle contient les identifiants de la base.
  logger.info('Connecté à MongoDB');

  const server = createApp().listen(env.PORT, () => {
    logger.info(`Serveur démarré sur le port ${env.PORT} en mode ${env.NODE_ENV}`);
    logger.info(`API URL: ${env.API_URL}`);
    logger.info(`Frontend URL: ${env.FRONTEND_URL}`);
  });

  // Après la connexion : une tâche lancée avant échouerait faute de base.
  if (env.NODE_ENV !== 'test') {
    startMaintenanceTasks();
  }

  const shutdown = createShutdownHandler({
    stopScheduledTasks,
    closeServer: () => closeServer(server),
    disconnectDatabase: () => mongoose.disconnect(),
    exit: (code) => process.exit(code),
    logger,
    timeoutMs: SHUTDOWN_TIMEOUT_MS
  });
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

start().catch((error) => {
  logger.error('Échec du démarrage', {
    error: error instanceof Error ? error.stack : String(error)
  });
  process.exit(1);
});
