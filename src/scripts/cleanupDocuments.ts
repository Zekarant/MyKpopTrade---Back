import { cleanExpiredDocuments } from '../commons/services/secureStorageService';
import logger from '../commons/utils/logger';

/**
 * Script de nettoyage des documents d'identité expirés
 * À exécuter via un cron job
 */
async function main() {
  try {
    logger.info('Début du nettoyage des documents expirés');
    cleanExpiredDocuments();
    logger.info('Nettoyage des documents expirés terminé');
  } catch (error) {
    logger.error('Erreur lors du nettoyage des documents expirés', { error });
  }
}

// Exécuter si lancé directement
if (require.main === module) {
  main().catch(console.error);
}