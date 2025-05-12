import mongoose from 'mongoose';
import User from '../models/userModel';
import Payment from '../models/paymentModel';
import logger from '../commons/utils/logger';
import dotenv from 'dotenv';

// Charger les variables d'environnement
dotenv.config();

/**
 * Script de maintenance pour appliquer la politique de rétention des données
 * - Exécute les suppressions de comptes programmées
 * - Anonymise les données de paiement après leur période de rétention
 */
async function applyDataRetentionPolicy(): Promise<void> {
  try {
    // Connexion à la base de données
    await mongoose.connect(process.env.MONGODB_URI as string);
    logger.info('Script de rétention des données démarré');
    
    // 1. Traiter les demandes de suppression de compte expirées
    const now = new Date();
    const usersToDelete = await User.find({
      scheduledForDeletion: true,
      scheduledDeletionDate: { $lte: now }
    });
    
    logger.info(`${usersToDelete.length} comptes prêts pour suppression`);
    
    for (const user of usersToDelete) {
      try {
        // Option 1: Anonymiser plutôt que supprimer (recommandé pour la cohérence des données)
        user.username = `deleted_${user._id.toString().substring(0, 8)}`;
        user.email = `deleted_${user._id.toString().substring(0, 8)}@deleted.com`;
        user.paypalEmail = undefined;
        user.profilePicture = 'https://mykpoptrade.com/images/avatar-default.png';
        user.password = 'DELETED_ACCOUNT';
        user.isActive = false;
        user.anonymized = true;
        user.marketingConsent = false;
        
        await user.save();
        
        logger.info(`Utilisateur anonymisé: ${user._id.toString().substring(0, 5)}...`);
        
        // Option 2: Suppression complète (attention aux références)
        // await User.deleteOne({ _id: user._id });
        // logger.info(`Utilisateur supprimé: ${user._id.toString().substring(0, 5)}...`);
      } catch (deleteError) {
        logger.error('Erreur lors de la suppression/anonymisation d\'un utilisateur', {
          error: deleteError instanceof Error ? deleteError.message : String(deleteError),
          userId: user._id.toString().substring(0, 5) + '...'
        });
      }
    }
    
    // 2. Anonymiser les données de paiement dont la période de rétention est expirée
    const expiredPayments = await Payment.find({
      retentionExpiresAt: { $lte: now }
    });
    
    logger.info(`${expiredPayments.length} paiements avec rétention expirée`);
    
    for (const payment of expiredPayments) {
      try {
        // Anonymiser les informations personnalisables
        payment.paymentIntentId = `anon_${payment._id.toString().substring(0, 8)}`;
        payment.paymentIntentEncrypted = undefined;
        payment.captureId = `anon_${payment._id.toString().substring(0, 8)}`;
        payment.captureIdEncrypted = undefined;
        payment.refundId = payment.refundId ? `anon_${payment._id.toString().substring(0, 8)}` : undefined;
        
        await payment.save();
        
        logger.info(`Paiement anonymisé: ${payment._id.toString().substring(0, 5)}...`);
      } catch (paymentError) {
        logger.error('Erreur lors de l\'anonymisation d\'un paiement', {
          error: paymentError instanceof Error ? paymentError.message : String(paymentError),
          paymentId: payment._id.toString().substring(0, 5) + '...'
        });
      }
    }
    
    logger.info('Script de rétention des données terminé avec succès');
  } catch (error) {
    logger.error('Erreur lors de l\'exécution du script de rétention des données', {
      error: error instanceof Error ? error.message : String(error)
    });
  } finally {
    // Fermer la connexion MongoDB
    await mongoose.connection.close();
  }
}

// Exécuter le script
applyDataRetentionPolicy();