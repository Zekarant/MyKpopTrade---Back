import mongoose from 'mongoose';
import env from '../config/env';
import logger from '../commons/utils/logger';
import { migrations } from '../migrations';
import { runMigrations } from '../migrations/runner';

/**
 * Applique les migrations en attente sur la base de MONGODB_URI.
 *
 *   npm run migrate
 *
 * À lancer à chaque déploiement, avant de démarrer la nouvelle version.
 */
async function main() {
  try {
    await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: env.MONGODB_SERVER_SELECTION_TIMEOUT_MS });
    const applied = await runMigrations(migrations);
    logger.info('migrations.done', { applied });
  } catch (error) {
    logger.error('migrations.failed', { error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

// Les erreurs sont gérées dans main (try/catch/finally).
void main();
