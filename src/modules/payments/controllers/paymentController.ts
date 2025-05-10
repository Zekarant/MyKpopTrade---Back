import { Request, Response } from 'express';
import { asyncHandler } from '../../../commons/middlewares/errorMiddleware';
import { PayPalService } from '../services/paypalService';
import Payment from '../../../models/paymentModel';
import Product from '../../../models/productModel';
import Conversation from '../../../models/conversationModel';
import { EncryptionService } from '../../../commons/utils/encryptionService';
import { NotificationService } from '../../notifications/services/notificationService';
import logger from '../../../commons/utils/logger';

/**
 * Initialise un paiement PayPal pour un produit
 */
export const initiatePayPalPayment = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const { productId, conversationId, paymentType } = req.body;
  
  try {
    // Récupérer les détails du produit
    const product = await Product.findById(productId).populate('seller', 'username');
    
    if (!product) {
      return res.status(404).json({ message: 'Produit non trouvé' });
    }
    
    if (!product.isAvailable) {
      return res.status(400).json({ message: 'Ce produit n\'est plus disponible' });
    }
    
    // Vérifier que l'acheteur n'est pas le vendeur
    if (product.seller._id.toString() === userId) {
      return res.status(400).json({ message: 'Vous ne pouvez pas acheter votre propre produit' });
    }
    
    // Déterminer le prix selon le type de paiement
    let amount = product.price;
    let description = `Achat de: ${product.title}`;
    
    // Pour les paiements de type négociation, vérifier le prix négocié
    if (paymentType === 'negotiation' && conversationId) {
      const conversation = await Conversation.findOne({
        _id: conversationId,
        participants: userId,
        type: 'negotiation',
        'negotiation.status': 'accepted'
      });
      
      if (!conversation) {
        return res.status(400).json({ 
          message: 'Aucune offre acceptée trouvée pour cette conversation' 
        });
      }
      
      // Utiliser le prix négocié
      amount = conversation.negotiation!.currentOffer;
      description += ` (Prix négocié)`;
    }
    // Pour les paiements de type PWYW, vérifier le prix proposé
    else if (paymentType === 'pwyw' && conversationId) {
      const conversation = await Conversation.findOne({
        _id: conversationId,
        participants: userId,
        type: 'pay_what_you_want',
        'payWhatYouWant.status': 'accepted'
      });
      
      if (!conversation) {
        return res.status(400).json({ 
          message: 'Aucune offre PWYW acceptée trouvée pour cette conversation' 
        });
      }
      
      // Utiliser le prix PWYW
      amount = conversation.payWhatYouWant!.proposedPrice!;
      description += ` (Pay What You Want)`;
    }
    
    // URLs de retour
    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const returnUrl = `${baseUrl}/payment/success`;
    const cancelUrl = `${baseUrl}/payment/cancel`;
    
    // Métadonnées pour le paiement
    const metadata = {
      productId: product._id.toString(),
      sellerId: product.seller._id.toString(),
      buyerId: userId,
      conversationId: conversationId || undefined,
      paymentType
    };
    
    // Créer le paiement avec PayPal
    const paymentDetails = await PayPalService.createPayment({
      amount,
      currency: product.currency,
      description,
      returnUrl,
      cancelUrl,
      userId,
      metadata
    });
    
    // Sauvegarder le paiement dans la base de données
    const paymentRecord = await Payment.create({
      buyer: userId,
      seller: product.seller._id,
      product: product._id,
      conversation: conversationId || undefined,
      amount,
      currency: product.currency,
      paymentIntentId: paymentDetails.id,
      status: 'pending',
      paymentMetadata: EncryptionService.encrypt(metadata),
      ipAddress: req.ip,
      userAgent: req.headers['user-agent']
    });
    
    return res.status(200).json({
      message: 'Paiement initié avec succès',
      payment: {
        id: paymentRecord._id,
        amount,
        currency: product.currency,
        status: paymentDetails.status,
        // URL pour rediriger l'utilisateur vers PayPal
        approvalUrl: paymentDetails.approvalUrl
      }
    });
  } catch (error) {
    logger.error('Erreur lors de l\'initiation du paiement PayPal', { error });
    return res.status(500).json({ 
      message: 'Une erreur est survenue lors de la création du paiement',
      error: process.env.NODE_ENV === 'development' 
        ? (error instanceof Error ? error.message : String(error)) 
        : undefined
    });
  }
});

/**
 * Vérifie et capture un paiement après approbation par l'utilisateur
 */
export const capturePayPalPayment = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const { orderId } = req.body;
  
  if (!orderId) {
    return res.status(400).json({ message: 'ID de commande PayPal requis' });
  }
  
  try {
    // Vérifier si le paiement existe dans notre base de données
    const paymentRecord = await Payment.findOne({ 
      paymentIntentId: orderId,
      buyer: userId,
      status: 'pending'
    });
    
    if (!paymentRecord) {
      return res.status(404).json({ message: 'Paiement non trouvé ou déjà traité' });
    }
    
    // Capturer le paiement avec PayPal
    const captureResult = await PayPalService.capturePayment(orderId, userId);
    
    if (captureResult.status === 'COMPLETED') {
      // Mettre à jour le statut du paiement
      paymentRecord.status = 'completed';
      paymentRecord.completedAt = new Date();
      await paymentRecord.save();
      
      // Mettre à jour le statut du produit
      await Product.findByIdAndUpdate(paymentRecord.product, {
        isAvailable: false,
        isReserved: true,
        reservedFor: userId
      });
      
      // Notifier le vendeur
      await NotificationService.createNotification({
        recipientId: paymentRecord.seller,
        type: 'product_sold',
        title: 'Produit vendu',
        content: `Votre produit a été acheté et payé avec succès !`,
        link: `/products/${paymentRecord.product}`,
        data: {
          productId: paymentRecord.product,
          paymentId: paymentRecord._id,
          buyerId: userId,
          amount: paymentRecord.amount,
          currency: paymentRecord.currency
        }
      });
      
      return res.status(200).json({
        message: 'Paiement capturé avec succès',
        payment: {
          id: paymentRecord._id,
          status: 'completed',
          captureId: captureResult.captureId,
          amountPaid: captureResult.amount.value,
          currency: captureResult.amount.currency_code,
          payerDetails: captureResult.payer,
          completedAt: paymentRecord.completedAt
        }
      });
    } else {
      // Le paiement n'a pas été complété
      return res.status(400).json({
        message: `Le paiement n'a pas pu être capturé (statut: ${captureResult.status})`,
        details: captureResult
      });
    }
  } catch (error) {
    logger.error('Erreur lors de la capture du paiement PayPal', { error, orderId });
    return res.status(500).json({ 
      message: 'Une erreur est survenue lors de la capture du paiement',
      error: process.env.NODE_ENV === 'development' 
        ? (error instanceof Error ? error.message : String(error)) 
        : undefined
    });
  }
});

/**
 * Liste les paiements de l'utilisateur actuel
 */
export const getMyPayments = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const { role = 'all', status, page = 1, limit = 10 } = req.query;
  
  try {
    // Construire le filtre
    const filter: any = {};
    
    // Filtrer par rôle (acheteur/vendeur)
    if (role === 'buyer') {
      filter.buyer = userId;
    } else if (role === 'seller') {
      filter.seller = userId;
    } else {
      // Par défaut, montrer tous les paiements de l'utilisateur
      filter.$or = [{ buyer: userId }, { seller: userId }];
    }
    
    // Filtrer par statut si spécifié
    if (status) {
      filter.status = status;
    }
    
    // Pagination
    const pageNum = parseInt(String(page), 10) || 1;
    const limitNum = parseInt(String(limit), 10) || 10;
    const skip = (pageNum - 1) * limitNum;
    
    // Récupérer les paiements avec les relations
    const payments = await Payment.find(filter)
      .populate('product', 'title images price currency')
      .populate('buyer', 'username profilePicture')
      .populate('seller', 'username profilePicture')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum);
    
    // Compter le total pour la pagination
    const total = await Payment.countDocuments(filter);
    
    // Traiter les données pour la réponse (conformité RGPD)
    const processedPayments = payments.map(payment => {
      const paymentObj = payment.toObject();
      
      // Supprimer les données techniques
      delete paymentObj.ipAddress;
      delete paymentObj.userAgent;
      
      // Déchiffrer les métadonnées si présentes
      if (paymentObj.paymentMetadata) {
        try {
          (paymentObj as any).metadata = EncryptionService.decrypt(paymentObj.paymentMetadata);
          delete paymentObj.paymentMetadata;
        } catch (error) {
          logger.warn('Erreur lors du déchiffrement des métadonnées', { 
            error, paymentId: payment._id 
          });
        }
      }
      
      return paymentObj;
    });
    
    return res.status(200).json({
      success: true,
      data: processedPayments,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum)
      }
    });
  } catch (error) {
    logger.error('Erreur lors de la récupération des paiements', { error });
    return res.status(500).json({ 
      message: 'Une erreur est survenue lors de la récupération des paiements',
      error: process.env.NODE_ENV === 'development' 
        ? (error instanceof Error ? error.message : String(error)) 
        : undefined
    });
  }
});

/**
 * Vérifie le statut d'un paiement
 */
export const checkPaymentStatus = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const { paymentId } = req.params;
  
  try {
    // Récupérer le paiement
    const payment = await Payment.findOne({
      _id: paymentId,
      $or: [{ buyer: userId }, { seller: userId }]
    });
    
    if (!payment) {
      return res.status(404).json({ message: 'Paiement non trouvé ou accès refusé' });
    }
    
    // Si le paiement est toujours en attente, vérifier le statut avec PayPal
    if (payment.status === 'pending') {
      const paymentDetails = await PayPalService.getPaymentDetails(
        payment.paymentIntentId, 
        userId
      );
      
      return res.status(200).json({
        message: 'Statut du paiement récupéré',
        payment: {
          id: payment._id,
          paypalOrderId: payment.paymentIntentId,
          amount: payment.amount,
          currency: payment.currency,
          status: paymentDetails.status,
          createdAt: payment.createdAt
        },
        paypalStatus: paymentDetails.status
      });
    }
    
    // Si le paiement est déjà complété ou a échoué
    return res.status(200).json({
      message: 'Statut du paiement récupéré',
      payment: {
        id: payment._id,
        paypalOrderId: payment.paymentIntentId,
        amount: payment.amount,
        currency: payment.currency,
        status: payment.status,
        createdAt: payment.createdAt,
        completedAt: payment.completedAt
      }
    });
  } catch (error) {
    logger.error('Erreur lors de la vérification du statut du paiement', { error, paymentId });
    return res.status(500).json({ 
      message: 'Une erreur est survenue lors de la vérification du statut du paiement'
    });
  }
});

/**
 * Rembourse un paiement (accessible uniquement par le vendeur)
 */
export const refundPayment = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const { paymentId } = req.params;
  const { reason, partial, amount } = req.body;
  try {
    // Récupérer le paiement
    const payment = await Payment.findOne({
      _id: paymentId,
      seller: userId,
      status: 'completed'
    });
    if (!payment) {
      return res.status(404).json({ 
        message: 'Paiement non trouvé, non complété ou vous n\'êtes pas le vendeur' 
      });
    }
    
    // Extraire l'ID de capture du PayPal Metadata (si disponible)
    let metadata: any = {};
    try {
      metadata = payment.paymentMetadata 
        ? EncryptionService.decrypt(payment.paymentMetadata) 
        : {};
    } catch (err) {
      logger.warn('Erreur lors du déchiffrement des métadonnées', { err, paymentId });
    }
    
    // Récupérer les détails du paiement pour obtenir l'ID de capture
    const paymentDetails = await PayPalService.getPaymentDetails(
      payment.paymentIntentId, 
      userId
    );
    
    const captureId = paymentDetails.purchase_units[0].payments.captures[0].id;
    
    // Montant à rembourser
    const refundAmount = partial && amount ? parseFloat(amount) : payment.amount;
    
    // Effectuer le remboursement
    const refundResult = await PayPalService.refundPayment(
      captureId,
      refundAmount,
      reason || 'Remboursement vendeur',
      userId
    );
    
    // Mettre à jour le statut du paiement
    payment.status = 'refunded';
    await payment.save();
    
    // Mettre à jour le produit (le rendre à nouveau disponible)
    await Product.findByIdAndUpdate(payment.product, {
      isAvailable: true,
      isReserved: false,
      reservedFor: null
    });
    
    // Notifier l'acheteur du remboursement
    await NotificationService.createNotification({
      recipientId: payment.buyer,
      type: 'system',
      title: 'Remboursement effectué',
      content: `Vous avez été remboursé de ${refundAmount} ${payment.currency} pour votre achat.`,
      link: `/account/purchases`,
      data: {
        productId: payment.product,
        paymentId: payment._id,
        sellerId: userId,
        refundAmount,
        currency: payment.currency,
        reason
      }
    });
    
    return res.status(200).json({
      message: 'Remboursement effectué avec succès',
      refund: {
        id: refundResult.id,
        amount: refundResult.refundAmount,
        status: refundResult.status,
        createdAt: refundResult.createdAt
      }
    });
  } catch (error) {
    logger.error('Erreur lors du remboursement', { error, paymentId });
    return res.status(500).json({ 
      message: 'Une erreur est survenue lors du remboursement',
      error: process.env.NODE_ENV === 'development' 
        ? (error instanceof Error ? error.message : String(error)) 
        : undefined
    });
  }
});