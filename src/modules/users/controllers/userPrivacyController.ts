import { Request, Response, NextFunction } from 'express';
import { asyncHandler } from '../../../commons/middlewares/errorMiddleware';
import User from '../../../models/userModel';
import Payment from '../../../models/paymentModel';
import Product from '../../../models/productModel';
import Conversation from '../../../models/conversationModel';
import { NotificationService } from '../../notifications/services/notificationService';
import logger from '../../../commons/utils/logger';
import { createHash } from 'crypto';

/**
 * Met à jour les consentements de l'utilisateur
 * @route PUT /api/users/me/consents
 * @access Private
 */
export const updateUserConsents = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  // Vérifier si l'utilisateur est authentifié
  const userId = (req.user as any).id;

  if (!userId) {
    return res.status(401).json({
      success: false,
      message: 'Vous devez être connecté pour mettre à jour vos consentements'
    });
  }

  const { privacyPolicy, dataProcessing, marketing } = req.body;
  
  try {
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Utilisateur non trouvé'
      });
    }
    
    // Mettre à jour les consentements avec horodatage
    const now = new Date();
    
    if (privacyPolicy !== undefined) {
      user.privacyPolicyAccepted = privacyPolicy;
      if (privacyPolicy) {
        user.privacyPolicyAcceptedAt = now;
      }
    }
    
    if (dataProcessing !== undefined) {
      user.dataProcessingConsent = dataProcessing;
      if (dataProcessing) {
        user.dataProcessingConsentAt = now;
      }
    }
    
    if (marketing !== undefined) {
      user.marketingConsent = marketing;
      if (marketing) {
        user.marketingConsentAt = now;
      }
    }
    
    await user.save();
    
    // Journaliser l'action
    logger.info('Consentements RGPD mis à jour', {
      userId: userId.substring(0, 5) + '...',
      privacyPolicy: user.privacyPolicyAccepted,
      dataProcessing: user.dataProcessingConsent,
      marketing: user.marketingConsent
    });
    
    return res.status(200).json({
      success: true,
      message: 'Consentements mis à jour avec succès',
      consents: {
        privacyPolicy: user.privacyPolicyAccepted,
        privacyPolicyAcceptedAt: user.privacyPolicyAcceptedAt,
        dataProcessing: user.dataProcessingConsent,
        dataProcessingConsentAt: user.dataProcessingConsentAt,
        marketing: user.marketingConsent,
        marketingConsentAt: user.marketingConsentAt
      }
    });
  } catch (error) {
    logger.error('Erreur lors de la mise à jour des consentements', {
      error: error instanceof Error ? error.message : String(error),
      userId: userId.substring(0, 5) + '...'
    });
    
    next(error);
  }
});

/**
 * Exporte les données personnelles de l'utilisateur (droit à la portabilité)
 * @route GET /api/users/me/data-export
 * @access Private
 */
export const exportUserData = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  
  if (!userId) {
    return res.status(401).json({
      success: false,
      message: 'Vous devez être connecté pour exporter vos données'
    });
  }
  
  try {
    // Récupérer les données de base de l'utilisateur
    const user = await User.findById(userId).select('-password');
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Utilisateur non trouvé'
      });
    }
    
    // Récupérer les données associées
    const [buyerPayments, sellerPayments, products, conversations] = await Promise.all([
      Payment.find({ buyer: userId })
        .select('-__v')
        .populate('product', 'title price currency'),
        
      Payment.find({ seller: userId })
        .select('-__v')
        .populate('product', 'title price currency'),
        
      Product.find({ seller: userId }).select('-__v'),
      
      Conversation.find({
        participants: userId
      }).select('title createdAt updatedAt')
    ]);
    
    // Construire l'objet de données
    const userData = {
      personnalInformation: {
        id: user._id,
        username: user.username,
        email: user.email,
        paypalEmail: user.paypalEmail,
        profilePicture: user.profilePicture,
        createdAt: user.createdAt,
        lastLogin: user.lastLoginAt,
        consents: {
          privacyPolicy: user.privacyPolicyAccepted,
          privacyPolicyAcceptedAt: user.privacyPolicyAcceptedAt,
          dataProcessing: user.dataProcessingConsent,
          dataProcessingConsentAt: user.dataProcessingConsentAt,
          marketing: user.marketingConsent,
          marketingConsentAt: user.marketingConsentAt
        }
      },
      payments: {
        asBuyer: buyerPayments,
        asSeller: sellerPayments
      },
      products: products,
      conversations: conversations
    };
    
    // Journaliser l'action (sans données personnelles)
    logger.info('Export de données personnelles effectué', {
      userId: userId.substring(0, 5) + '...'
    });
    
    // Générer un nom de fichier unique
    const fileName = `user-data-${createHash('sha256').update(userId).digest('hex').substring(0, 8)}-${Date.now()}.json`;
    
    // Envoyer les données en format JSON téléchargeable
    res.setHeader('Content-Disposition', `attachment; filename=${fileName}`);
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json(userData);
    
  } catch (error) {
    logger.error('Erreur lors de l\'export des données personnelles', {
      error: error instanceof Error ? error.message : String(error),
      userId: userId.substring(0, 5) + '...'
    });
    
    return res.status(500).json({
      success: false,
      message: 'Une erreur est survenue lors de l\'export de vos données personnelles'
    });
  }
});

/**
 * Demande de suppression du compte utilisateur (droit à l'effacement)
 * @route POST /api/users/me/deletion-request
 * @access Private
 */
export const requestAccountDeletion = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  
  if (!userId) {
    return res.status(401).json({
      success: false,
      message: 'Vous devez être connecté pour demander la suppression de votre compte'
    });
  }
  
  const { confirmation } = req.body;
  
  try {
    // Vérifier la confirmation
    if (confirmation !== true) {
      return res.status(400).json({
        success: false,
        message: 'Veuillez confirmer votre demande de suppression'
      });
    }
    
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Utilisateur non trouvé'
      });
    }
    
    // Vérifier si l'utilisateur a des paiements en cours
    const pendingPayments = await Payment.countDocuments({
      $or: [
        { buyer: userId, status: 'pending' },
        { seller: userId, status: 'pending' }
      ]
    });
    
    if (pendingPayments > 0) {
      return res.status(400).json({
        success: false,
        message: 'Impossible de supprimer votre compte car vous avez des paiements en cours. Veuillez les finaliser d\'abord.'
      });
    }
    
    // Programmer la suppression dans 30 jours
    const deletionDate = new Date();
    deletionDate.setDate(deletionDate.getDate() + 30);
    
    user.scheduledForDeletion = true;
    user.scheduledDeletionDate = deletionDate;
    await user.save();
    
    // Envoyer un email de confirmation à l'utilisateur
    // emailService.sendDeletionRequestConfirmation(user.email, deletionDate);
    
    // Journaliser l'action
    logger.info('Demande de suppression de compte reçue', {
      userId: userId.substring(0, 5) + '...',
      scheduledDeletionDate: deletionDate
    });
    
    // Envoyer une notification dans l'application
    await NotificationService.createNotification({
      recipientId: userId,
      type: 'system',
      title: 'Demande de suppression de compte',
      content: `Votre demande de suppression a été enregistrée. Votre compte sera supprimé le ${deletionDate.toLocaleDateString()}.`,
      link: '/account/settings',
      data: {
        scheduledDeletionDate: deletionDate
      }
    });
    
    return res.status(200).json({
      success: true,
      message: 'Votre demande de suppression a été enregistrée',
      scheduledDeletionDate: deletionDate
    });
  } catch (error) {
    logger.error('Erreur lors de la demande de suppression de compte', {
      error: error instanceof Error ? error.message : String(error),
      userId: userId.substring(0, 5) + '...'
    });
    
    return res.status(500).json({
      success: false,
      message: 'Une erreur est survenue lors du traitement de votre demande'
    });
  }
});

/**
 * Annule une demande de suppression de compte
 * @route DELETE /api/users/me/deletion-request
 * @access Private
 */
export const cancelDeletionRequest = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  
  if (!userId) {
    return res.status(401).json({
      success: false,
      message: 'Vous devez être connecté pour annuler une demande de suppression'
    });
  }
  
  try {
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Utilisateur non trouvé'
      });
    }
    
    if (!user.scheduledForDeletion) {
      return res.status(400).json({
        success: false,
        message: 'Aucune demande de suppression n\'est en cours pour ce compte'
      });
    }
    
    // Annuler la suppression programmée
    user.scheduledForDeletion = false;
    user.scheduledDeletionDate = undefined;
    await user.save();
    
    // Journaliser l'action
    logger.info('Demande de suppression de compte annulée', {
      userId: userId.substring(0, 5) + '...'
    });
    
    // Notification à l'utilisateur
    await NotificationService.createNotification({
      recipientId: userId,
      type: 'system',
      title: 'Annulation de la demande de suppression',
      content: 'Votre demande de suppression de compte a été annulée avec succès.',
      link: '/account/settings'
    });
    
    return res.status(200).json({
      success: true,
      message: 'Votre demande de suppression a été annulée avec succès'
    });
  } catch (error) {
    logger.error('Erreur lors de l\'annulation de la demande de suppression', {
      error: error instanceof Error ? error.message : String(error),
      userId: userId.substring(0, 5) + '...'
    });
    
    return res.status(500).json({
      success: false,
      message: 'Une erreur est survenue lors de l\'annulation de votre demande'
    });
  }
});

/**
 * Anonymise les données personnelles (alternative à la suppression)
 * @route POST /api/users/me/anonymize
 * @access Private
 */
export const anonymizeUserData = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  
  if (!userId) {
    return res.status(401).json({
      success: false,
      message: 'Vous devez être connecté pour anonymiser vos données'
    });
  }
  
  const { confirmation } = req.body;
  
  try {
    // Vérifier la confirmation
    if (confirmation !== true) {
      return res.status(400).json({
        success: false,
        message: 'Veuillez confirmer votre demande d\'anonymisation'
      });
    }
    
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Utilisateur non trouvé'
      });
    }
    
    // Générer un identifiant aléatoire pour l'anonymisation
    const anonymousId = `anon_${createHash('sha256').update(userId + Date.now().toString()).digest('hex').substring(0, 10)}`;
    
    // Anonymiser les données personnelles
    user.username = anonymousId;
    user.email = `${anonymousId}@anonymized.com`;
    user.paypalEmail = undefined;
    user.profilePicture = 'https://mykpoptrade.com/images/avatar-default.png';
    user.anonymized = true;
    
    // Révoquer les consentements
    user.marketingConsent = false;
    
    await user.save();
    
    // Journaliser l'action
    logger.info('Données utilisateur anonymisées', {
      userId: userId.substring(0, 5) + '...'
    });
    
    return res.status(200).json({
      success: true,
      message: 'Vos données personnelles ont été anonymisées avec succès'
    });
  } catch (error) {
    logger.error('Erreur lors de l\'anonymisation des données', {
      error: error instanceof Error ? error.message : String(error),
      userId: userId.substring(0, 5) + '...'
    });
    
    return res.status(500).json({
      success: false,
      message: 'Une erreur est survenue lors de l\'anonymisation de vos données'
    });
  }
});