import cron from 'node-cron';
import logger from '../utils/logger';
import Product from '../../models/productModel';
import Payment from '../../models/paymentModel';

/**
 * Libère les réservations de produits expirées (reservedUntil dépassé)
 * et annule les paiements associés encore en attente.
 *
 * Exécution toutes les 10 minutes pour éviter que des produits restent
 * bloqués si le frontend n'a pas pu appeler l'annulation (fermeture
 * du navigateur, erreur réseau, etc.).
 */
async function releaseExpiredReservations(): Promise<void> {
  const now = new Date();

  const expiredProducts = await Product.find({
    isReserved: true,
    reservedUntil: { $lt: now },
    isSold: false
  }).select('_id reservedFor');

  if (expiredProducts.length === 0) return;

  const productIds = expiredProducts.map(p => p._id);

  // Libérer les réservations expirées
  await Product.updateMany(
    { _id: { $in: productIds } },
    {
      isReserved: false,
      reservedFor: null,
      reservedUntil: null
    }
  );

  // Annuler les paiements pending associés
  await Payment.updateMany(
    {
      product: { $in: productIds },
      status: 'pending'
    },
    { status: 'cancelled' }
  );

  logger.info('Réservations expirées libérées', {
    count: expiredProducts.length,
    productIds: productIds.map(id => id.toString())
  });
}

export const startReservationCleanupTask = () => {
  cron.schedule('*/10 * * * *', async () => {
    try {
      await releaseExpiredReservations();
    } catch (error) {
      logger.error('Erreur cron nettoyage réservations expirées', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }, { timezone: 'Europe/Paris' });

  logger.info('Tâche CRON nettoyage réservations programmée', {
    schedule: '*/10 * * * *',
    timezone: 'Europe/Paris'
  });
};
