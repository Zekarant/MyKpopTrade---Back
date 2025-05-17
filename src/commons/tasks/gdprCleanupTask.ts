import cron from 'node-cron';
import Payment from '../../models/paymentModel';
import { EncryptionService } from '../utils/encryptionService';
import { GdprLogger } from '../utils/gdprLogger';

/**
 * Tâche d'anonymisation automatique des vieux paiements (RGPD)
 * S'exécute une fois par semaine (le dimanche à 3h du matin)
 */
export const startGdprCleanupTask = () => {
  cron.schedule('0 3 * * 0', async () => {
    try {
      GdprLogger.logInfo('Démarrage de la tâche d\'anonymisation GDPR', {});
      
      // Trouver tous les paiements complétés datant de plus de 3 ans
      const cutoffDate = new Date();
      cutoffDate.setFullYear(cutoffDate.getFullYear() - 3);
      
      const paymentsToAnonymize = await Payment.find({
        status: { $in: ['completed', 'refunded', 'partially_refunded'] },
        updatedAt: { $lt: cutoffDate },
        anonymized: { $ne: true }
      });
      
      let count = 0;
      
      for (const payment of paymentsToAnonymize) {
        // Conserver uniquement les données nécessaires pour l'historique comptable
        const retainedData = {
          transactionDate: payment.completedAt || payment.createdAt,
          amount: payment.amount,
          currency: payment.currency,
          status: payment.status,
          refundAmount: payment.refundAmount || null,
          refundedAt: payment.refundedAt || null,
          productId: payment.product.toString(),
          transactionReference: payment.captureId || payment.paymentIntentId
        };
        
        // Anonymiser le paiement
        payment.paypalEmail = 'anonymized@example.com';
        payment.buyerDetails = undefined;
        payment.ipAddress = '0.0.0.0';
        payment.userAgent = 'anonymized';
        payment.anonymized = true;
        payment.paymentMetadata = EncryptionService.encrypt(JSON.stringify(retainedData));
        
        await payment.save();
        count++;
      }
      
      GdprLogger.logInfo('Anonymisation périodique des données de paiement terminée', {
        count,
        operation: 'scheduled_gdpr_cleanup'
      });
    } catch (error) {
      GdprLogger.logError('Erreur lors de l\'anonymisation automatique des données', error);
    }
  }, {
    timezone: 'Europe/Paris'
  });
  
  GdprLogger.logInfo('Tâche d\'anonymisation GDPR programmée', {
    schedule: '0 3 * * 0',
    timezone: 'Europe/Paris'
  });
};