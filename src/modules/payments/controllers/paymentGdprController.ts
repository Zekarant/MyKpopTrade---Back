import { Request, Response } from 'express';
import { asyncHandler } from '../../../commons/middlewares/errorMiddleware';
import Payment from '../../../models/paymentModel';
import Product from '../../../models/productModel';
import User from '../../../models/userModel';
import { EncryptionService } from '../../../commons/utils/encryptionService';
import { GdprLogger } from '../../../commons/utils/gdprLogger';

/**
 * Exporte les données de paiement d'un utilisateur (droit à la portabilité)
 * @route GET /api/payments/export
 * @access Private
 */
export const exportPaymentData = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  
  if (!userId) {
    return res.status(401).json({
      success: false,
      message: 'Authentification requise'
    });
  }
  
  try {
    // Récupérer tous les paiements de l'utilisateur (achat et vente)
    const payments = await Payment.find({
      $or: [{ buyer: userId }, { seller: userId }]
    })
    .populate('product', 'title images price currency')
    .sort({ createdAt: -1 });
    
    // Formater les données en respectant la portabilité (format commun et lisible)
    const formattedData = payments.map(payment => {
      const paymentData: any = {
        transaction_id: payment._id.toString(),
        external_reference: payment.captureId || payment.paymentIntentId,
        date: payment.createdAt.toISOString(),
        completed_at: payment.completedAt ? payment.completedAt.toISOString() : null,
        amount: payment.amount,
        currency: payment.currency,
        status: payment.status,
        payment_method: payment.paymentMethod,
        product: {
          id: payment.product._id.toString(),
          title: payment.product.title,
          price: payment.product.price,
          currency: payment.product.currency
        }
      };
      
      // N'inclure que les données pertinentes pour l'utilisateur
      if (payment.buyer.toString() === userId) {
        paymentData.role = 'buyer';
        // Ne pas inclure les détails du vendeur pour respecter sa vie privée
      } else {
        paymentData.role = 'seller';
        // Ne pas inclure les détails de l'acheteur pour respecter sa vie privée
      }
      
      // Ajouter les informations de remboursement si présentes
      if (payment.refundAmount) {
        paymentData.refund = {
          amount: payment.refundAmount,
          date: payment.refundedAt ? payment.refundedAt.toISOString() : null,
          reference: payment.refundId
        };
      }
      
      return paymentData;
    });
    
    // Générer un nom de fichier unique
    const filename = `mykpoptrade_payments_export_${Date.now()}.json`;
    
    // Journal d'audit pour la conformité
    GdprLogger.logPaymentAction('export_payment_data', { count: formattedData.length }, userId);
    
    // Envoyer les données sous forme de fichier JSON téléchargeable
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json({
      data: formattedData,
      exported_at: new Date().toISOString(),
      user_id: userId
    });
  } catch (error) {
    GdprLogger.logPaymentError(error, userId, { action: 'export_payment_data' });
    
    return res.status(500).json({
      success: false,
      message: 'Une erreur est survenue lors de l\'export des données de paiement'
    });
  }
});

/**
 * Anonymise les données personnelles d'un utilisateur dans les paiements
 * @route POST /api/payments/gdpr/anonymize
 * @access Private
 */
export const anonymizeUserPaymentData = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const { password } = req.body;
  
  if (!userId) {
    return res.status(401).json({
      success: false,
      message: 'Authentification requise'
    });
  }
  
  try {
    // Vérifier le mot de passe pour confirmer l'action
    const user = await User.findById(userId).select('+password');
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Utilisateur non trouvé'
      });
    }
    
    const isPasswordValid = await user.comparePassword(password);
    if (!isPasswordValid) {
      return res.status(400).json({
        success: false,
        message: 'Mot de passe incorrect'
      });
    }
    
    // Trouver tous les paiements où l'utilisateur est acheteur
    const buyerPayments = await Payment.find({ buyer: userId });
    
    // Anonymiser les données personnelles dans ces paiements
    let count = 0;
    for (const payment of buyerPayments) {
      // Pour les paiements où l'utilisateur est acheteur
      payment.paypalEmail = 'anonymized@example.com';
      payment.buyerDetails = undefined;
      payment.ipAddress = '0.0.0.0';
      payment.userAgent = 'anonymized';
      payment.anonymized = true;
      
      // Stocker uniquement les données nécessaires pour l'obligation légale (comptabilité)
      // en minimisant les données personnelles
      const retainedData = {
        transactionDate: payment.completedAt || payment.createdAt,
        amount: payment.amount,
        currency: payment.currency,
        status: payment.status,
        transactionReference: payment.captureId || payment.paymentIntentId
      };
      
      payment.paymentMetadata = EncryptionService.encrypt(JSON.stringify(retainedData));
      
      await payment.save();
      count++;
    }
    
    // Journal d'audit pour la conformité
    GdprLogger.logPaymentAction('anonymize_payment_data', { count }, userId);
    
    return res.status(200).json({
      success: true,
      message: `${count} paiements ont été anonymisés conformément à votre demande.`
    });
  } catch (error) {
    GdprLogger.logPaymentError(error, userId, { action: 'anonymize_payment_data' });
    
    return res.status(500).json({
      success: false,
      message: 'Une erreur est survenue lors de l\'anonymisation des données'
    });
  }
});

/**
 * Anonymise les données de paiement anciennes (à exécuter via une tâche cron)
 * Conformité RGPD: conservation limitée dans le temps
 */
export const anonymizeOldPayments = asyncHandler(async (req: Request, res: Response) => {
  try {
    // Vérifier que l'utilisateur est admin
    const userId = (req.user as any).id;
    const user = await User.findById(userId);
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ 
        success: false, 
        message: 'Action réservée aux administrateurs' 
      });
    }
    
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
      // tout en anonymisant les données personnelles
      const retainedData = {
        transactionDate: payment.completedAt || payment.createdAt,
        amount: payment.amount,
        currency: payment.currency,
        status: payment.status,
        refundAmount: payment.refundAmount || null,
        refundedAt: payment.refundedAt || null,
        // Conservation du lien avec le produit pour l'historique comptable
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
    
    // Log d'audit pour démontrer la conformité
    GdprLogger.logPaymentAction('anonymize_old_payments', { 
      count,
      operationType: 'gdpr_data_retention_policy',
      retention_period: '3 years'
    }, userId);
    
    return res.status(200).json({
      success: true,
      message: `${count} paiements ont été anonymisés conformément à la politique de conservation des données.`
    });
  } catch (error) {
    GdprLogger.logError('Erreur lors de l\'anonymisation des anciennes données de paiement', error);
    
    return res.status(500).json({
      success: false,
      message: 'Une erreur est survenue lors de l\'anonymisation des données'
    });
  }
});