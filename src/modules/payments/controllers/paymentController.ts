import { Request, Response } from 'express';
import { asyncHandler } from '../../../commons/middlewares/errorMiddleware';
import { PayPalService } from '../services/paypalService';
import Payment from '../../../models/paymentModel';
import Product from '../../../models/productModel';
import User from '../../../models/userModel';
import { EncryptionService } from '../../../commons/utils/encryptionService';
import { NotificationService } from '../../notifications/services/notificationService';
import logger from '../../../commons/utils/logger';

/**
 * Génère l'URL pour connecter un compte vendeur à PayPal
 */
export const generateConnectUrl = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  
  try {
    // Vérifier si le vendeur existe
    const seller = await User.findById(userId);
    if (!seller) {
      return res.status(404).json({ message: 'Utilisateur non trouvé' });
    }
    
    // Générer l'URL de connexion
    const connectUrl = PayPalService.generateConnectUrl(userId);
    
    // Journaliser la demande sans données personnelles
    logger.info('URL de connexion PayPal générée', { userId: userId });
    
    return res.status(200).json({
      success: true,
      connectUrl,
      message: 'URL de connexion PayPal générée avec succès'
    });
  } catch (error) {
    logger.error('Erreur lors de la génération de l\'URL de connexion PayPal', { 
      error: error instanceof Error ? error.message : String(error),
      userId: userId.substring(0, 5) + '...'
    });
    return res.status(500).json({ 
      message: 'Une erreur est survenue lors de la génération de l\'URL de connexion PayPal',
      error: process.env.NODE_ENV === 'development' 
        ? (error instanceof Error ? error.message : String(error)) 
        : undefined
    });
  }
});

/**
 * Gère le callback OAuth de PayPal après la connexion d'un compte vendeur
 */
export const handleConnectCallback = asyncHandler(async (req: Request, res: Response) => {
  const { code, state } = req.query;
  
  if (!code || !state) {
    return res.status(400).redirect(`${process.env.FRONTEND_URL}/account/seller/settings?error=missing_parameters`);
  }
  
  try {
    // Le state contient l'ID du vendeur
    const sellerId = state as string;
    
    // Vérifier que l'utilisateur existe
    const seller = await User.findById(sellerId);
    if (!seller) {
      return res.status(404).redirect(`${process.env.FRONTEND_URL}/account/seller/settings?error=user_not_found`);
    }
    
    // Traiter le callback et obtenir les tokens
    const success = await PayPalService.handleConnectCallback(code as string, sellerId);
    
    if (success) {
      // Journaliser sans données personnelles
      logger.info('Compte PayPal connecté avec succès', {
        userId: sellerId.substring(0, 5) + '...'
      });
      
      // Rediriger vers la page de paramètres du vendeur avec un message de succès
      return res.redirect(`${process.env.FRONTEND_URL}/account/seller/settings?paypal_connected=true`);
    } else {
      return res.redirect(`${process.env.FRONTEND_URL}/account/seller/settings?error=connection_failed`);
    }
  } catch (error) {
    const sellerId = state as string;
    logger.error('Erreur lors du callback de connexion PayPal', { 
      error: error instanceof Error ? error.message : String(error),
      userId: sellerId.substring(0, 5) + '...'
    });
    return res.redirect(`${process.env.FRONTEND_URL}/account/seller/settings?error=server_error`);
  }
});

/**
 * Vérifie l'état de connexion PayPal du vendeur
 */
export const checkPayPalConnection = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  
  try {
    // Récupérer l'utilisateur et ses informations PayPal
    const user = await User.findById(userId).select('paypalConnected paypalTokens.expiresAt');
    
    if (!user) {
      return res.status(404).json({ message: 'Utilisateur non trouvé' });
    }
    
    // Vérifier si les tokens sont expirés
    let tokensValid = false;
    if (user.paypalTokens && user.paypalTokens.expiresAt) {
      tokensValid = new Date(user.paypalTokens.expiresAt) > new Date();
    }
    
    return res.status(200).json({
      success: true,
      connected: user.paypalConnected && tokensValid,
      expiresAt: user.paypalTokens?.expiresAt || null
    });
  } catch (error) {
    logger.error('Erreur lors de la vérification de la connexion PayPal', { 
      error: error instanceof Error ? error.message : String(error),
      userId: userId.substring(0, 5) + '...'
    });
    return res.status(500).json({ 
      message: 'Une erreur est survenue lors de la vérification de la connexion PayPal',
      error: process.env.NODE_ENV === 'development' 
        ? (error instanceof Error ? error.message : String(error)) 
        : undefined
    });
  }
});

/**
 * Déconnecte le compte PayPal du vendeur
 */
export const disconnectPayPal = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  
  try {
    // Mettre à jour l'utilisateur pour supprimer les informations de connexion PayPal
    const user = await User.findByIdAndUpdate(userId, {
      paypalConnected: false,
      $unset: { paypalTokens: 1 }  // Supprimer complètement les tokens pour respecter le RGPD
    }, { new: true });
    
    if (!user) {
      return res.status(404).json({ message: 'Utilisateur non trouvé' });
    }
    
    logger.info('Compte PayPal déconnecté', { userId: userId.substring(0, 5) + '...' });
    
    return res.status(200).json({
      success: true,
      message: 'Compte PayPal déconnecté avec succès'
    });
  } catch (error) {
    logger.error('Erreur lors de la déconnexion du compte PayPal', { 
      error: error instanceof Error ? error.message : String(error),
      userId: userId.substring(0, 5) + '...' 
    });
    return res.status(500).json({ 
      message: 'Une erreur est survenue lors de la déconnexion du compte PayPal',
      error: process.env.NODE_ENV === 'development' 
        ? (error instanceof Error ? error.message : String(error)) 
        : undefined
    });
  }
});

/**
 * Initie un paiement PayPal pour un produit
 */
export const initiatePayPalPayment = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const { productId } = req.body;
  
  if (!productId) {
    return res.status(400).json({ message: 'ID du produit requis' });
  }
  
  try {
    // Vérifier que le produit existe et est disponible
    const product = await Product.findOne({
      _id: productId,
      isAvailable: true,
      isSold: false,
      isReserved: false
    });
    
    if (!product) {
      return res.status(404).json({ message: 'Produit non trouvé ou non disponible' });
    }
    
    // Vérifier que l'utilisateur n'est pas le vendeur
    if (product.seller.toString() === userId) {
      return res.status(400).json({ message: 'Vous ne pouvez pas acheter votre propre produit' });
    }
    
    // Créer le paiement direct
    const paymentResponse = await PayPalService.createDirectPayment(
      productId, 
      userId
    );
    
    return res.status(200).json({
      success: true,
      payment: {
        id: paymentResponse.paymentId,
        paypalOrderId: paymentResponse.orderId,
        amount: paymentResponse.amount,
        currency: paymentResponse.currency,
        approvalUrl: paymentResponse.approvalUrl
      },
      message: 'Paiement initié avec succès'
    });
  } catch (error) {
    logger.error('Erreur lors de l\'initiation du paiement PayPal', { 
      error: error instanceof Error ? error.message : String(error),
      productId,
      userId: userId.substring(0, 5) + '...'
    });
    return res.status(500).json({ 
      message: 'Une erreur est survenue lors de la création du paiement',
      error: process.env.NODE_ENV === 'development' 
        ? (error instanceof Error ? error.message : String(error)) 
        : undefined
    });
  }
});

/**
 * Capture un paiement après approbation par l'acheteur
 */
export const capturePayPalPayment = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const { orderId } = req.body;
  
  if (!orderId) {
    return res.status(400).json({ message: 'ID de commande PayPal requis' });
  }
  
  try {
    // Rechercher le paiement dans notre base
    const payment = await Payment.findOne({ 
      paymentIntentId: orderId,
      buyer: userId,
      status: 'pending'
    });
    
    if (!payment) {
      return res.status(404).json({ message: 'Paiement non trouvé ou déjà traité' });
    }
    
    // Récupérer le vendeur pour utiliser son token
    const seller = await User.findById(payment.seller);
    if (!seller || !seller.paypalConnected) {
      return res.status(400).json({ 
        message: 'Vendeur non disponible ou non connecté à PayPal',
        code: 'SELLER_UNAVAILABLE'
      });
    }
    
    // Capturer le paiement avec les tokens du vendeur
    const captureResult = await PayPalService.captureConnectedPayment(
      orderId,
      payment.seller.toString()
    );
    
    // Mettre à jour le statut du paiement
    payment.status = 'completed';
    payment.completedAt = new Date();
    payment.captureId = captureResult.captureId;
    await payment.save();
    
    // Mettre à jour le produit
    await Product.findByIdAndUpdate(payment.product, {
      isAvailable: false,
      isSold: true,
      soldAt: new Date(),
      soldTo: payment.buyer
    });
    
    // Notifier le vendeur de manière RGPD compliant (sans données personnelles de l'acheteur)
    await NotificationService.createNotification({
      recipientId: payment.seller,
      type: 'system',
      title: 'Nouveau paiement reçu',
      content: `Votre produit a été acheté pour ${payment.amount} ${payment.currency}.`,
      link: `/account/sales/${payment._id}`,
      data: {
        paymentId: payment._id,
        productId: payment.product,
        amount: payment.amount,
        currency: payment.currency
      }
    });
    
    return res.status(200).json({
      success: true,
      payment: {
        id: payment._id,
        status: 'completed',
        captureId: captureResult.captureId,
        amount: captureResult.amount,
        currency: captureResult.currency
      },
      message: 'Paiement capturé avec succès'
    });
  } catch (error) {
    logger.error('Erreur lors de la capture du paiement PayPal', { 
      error: error instanceof Error ? error.message : String(error),
      orderId,
      userId: userId.substring(0, 5) + '...' 
    });
    return res.status(500).json({ 
      message: 'Une erreur est survenue lors de la capture du paiement',
      error: process.env.NODE_ENV === 'development' 
        ? (error instanceof Error ? error.message : String(error)) 
        : undefined
    });
  }
});

/**
 * Confirme un paiement après redirection depuis PayPal
 */
export const confirmPayPalPayment = asyncHandler(async (req: Request, res: Response) => {
  const { orderId } = req.query;
  
  if (!orderId) {
    return res.redirect(`${process.env.FRONTEND_URL}/payment/error?code=missing_order_id`);
  }
  
  try {
    // Rechercher le paiement
    const payment = await Payment.findOne({ paymentIntentId: orderId });
    if (!payment) {
      return res.redirect(`${process.env.FRONTEND_URL}/payment/error?code=payment_not_found`);
    }
    
    // Récupérer le vendeur
    const seller = await User.findById(payment.seller);
    if (!seller) {
      return res.redirect(`${process.env.FRONTEND_URL}/payment/error?code=seller_unavailable`);
    }
    
    // Vérifier l'état du paiement - Utiliser checkPaymentStatus au lieu de getPaymentStatus
    const paymentStatus = await PayPalService.checkPaymentStatus(orderId as string);
    
    if (paymentStatus === 'APPROVED') {
      // Si approuvé mais pas encore capturé, rediriger vers la page de confirmation
      return res.redirect(
        `${process.env.FRONTEND_URL}/payment/confirm?orderId=${orderId}&paymentId=${payment._id}`
      );
    } else if (paymentStatus === 'COMPLETED') {
      // Si déjà complété, mettre à jour notre base de données
      if (payment.status !== 'completed') {
        payment.status = 'completed';
        payment.completedAt = new Date();
        await payment.save();
        
        // Mettre à jour le produit
        await Product.findByIdAndUpdate(payment.product, {
          isAvailable: false,
          isSold: true,
          soldAt: new Date(),
          soldTo: payment.buyer
        });
      }
      
      return res.redirect(`${process.env.FRONTEND_URL}/payment/success?paymentId=${payment._id}`);
    } else {
      // Autres statuts
      return res.redirect(
        `${process.env.FRONTEND_URL}/payment/status?orderId=${orderId}&status=${paymentStatus}`
      );
    }
  } catch (error) {
    logger.error('Erreur lors de la confirmation du paiement', { 
      error: error instanceof Error ? error.message : String(error),
      orderId: String(orderId)
    });
    return res.redirect(`${process.env.FRONTEND_URL}/payment/error?code=server_error`);
  }
});

/**
 * Gère les webhooks PayPal pour les notifications automatiques
 */
/**
 * Gère les webhooks PayPal pour les notifications automatiques de paiement
 * @route POST /api/payments/webhook/paypal
 * @access public - Ne nécessite pas d'authentification (appelé par PayPal)
 */
export const handleWebhook = asyncHandler(async (req: Request, res: Response) => {
  try {
    // Récupérer l'événement du corps de la requête
    const event = req.body;
    
    // Vérifier que l'événement est valide
    if (!event || !event.event_type) {
      logger.warn('Webhook PayPal reçu avec un format invalide');
      return res.status(400).json({ message: 'Format de webhook invalide' });
    }
    
    // Journaliser l'événement reçu pour le débogage (sans données sensibles)
    logger.debug('Webhook PayPal reçu', {
      eventType: event.event_type,
      eventId: event.id,
      resourceType: event.resource_type || 'non spécifié'
    });
    
    // En environnement de production, vérifier l'authenticité du webhook
    if (process.env.NODE_ENV === 'production') {
      // La vérification de la signature serait implémentée ici
      // Pour l'instant, on accepte tous les webhooks en développement
      logger.debug('Vérification de la signature du webhook ignorée en développement');
    }
    
    // Traiter l'événement avec le service PayPal
    await PayPalService.handleWebhook(event);
    
    // Renvoyer un succès à PayPal pour éviter les retentatives
    return res.status(200).json({ 
      received: true,
      eventType: event.event_type
    });
  } catch (error) {
    // En cas d'erreur, journaliser mais renvoyer quand même un succès à PayPal
    // pour éviter les retentatives (les erreurs seront traitées en interne)
    logger.error('Erreur lors du traitement du webhook PayPal', { 
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    
    // Renvoyer 200 OK même en cas d'erreur pour éviter les retentatives de PayPal
    return res.status(200).json({ 
      received: true,
      processingError: process.env.NODE_ENV === 'development' 
        ? (error instanceof Error ? error.message : String(error))
        : 'Une erreur est survenue lors du traitement'
    });
  }
});

/**
 * Traite les événements de capture de paiement complétée
 */
async function handleCaptureCompleted(event: any) {
  try {
    const resource = event.resource;
    const orderId = resource.supplementary_data?.related_ids?.order_id || 
                    resource.invoice_id || 
                    resource.custom_id;
    
    if (!orderId) {
      logger.warn('Impossible de déterminer l\'orderId dans l\'événement de capture', { 
        resourceId: resource.id 
      });
      return;
    }
    
    // Rechercher le paiement correspondant
    const payment = await Payment.findOne({ paymentIntentId: orderId });
    
    if (!payment) {
      logger.warn('Aucun paiement trouvé pour l\'orderId', { orderId });
      return;
    }
    
    // Mettre à jour le statut du paiement
    if (payment.status !== 'completed') {
      payment.status = 'completed';
      payment.captureId = resource.id;
      payment.completedAt = new Date();
      await payment.save();
      
      // Mettre à jour le statut du produit
      await Product.findByIdAndUpdate(payment.product, {
        isAvailable: false,
        isSold: true,
        soldAt: new Date(),
        soldTo: payment.buyer
      });
      
      // Notifier le vendeur
      await NotificationService.createNotification({
        recipientId: payment.seller,
        type: 'system',
        title: 'Nouveau paiement reçu',
        content: `Un acheteur a payé ${payment.amount} ${payment.currency} pour votre produit.`,
        link: `/account/sales/${payment._id}`,
        data: {
          paymentId: payment._id,
          productId: payment.product,
          amount: payment.amount,
          currency: payment.currency
        }
      });
    }
  } catch (error) {
    logger.error('Erreur lors du traitement de l\'événement PAYMENT.CAPTURE.COMPLETED', { error });
    throw error;
  }
}

/**
 * Traite les événements de remboursement
 */
async function handleRefund(event: any) {
  try {
    const resource = event.resource;
    const captureId = resource.links.find((link: any) => link.rel === 'up')?.href.split('/').pop();
    
    if (!captureId) {
      logger.warn('Impossible de déterminer le captureId dans l\'événement de remboursement', { 
        resourceId: resource.id 
      });
      return;
    }
    
    // Rechercher le paiement correspondant
    const payment = await Payment.findOne({ captureId });
    
    if (!payment) {
      logger.warn('Aucun paiement trouvé pour le captureId', { captureId });
      return;
    }
    
    // Déterminer s'il s'agit d'un remboursement partiel ou complet
    const refundAmount = parseFloat(resource.amount.value);
    const isPartialRefund = refundAmount < payment.amount;
    
    // Mettre à jour le statut du paiement
    payment.status = isPartialRefund ? 'partially_refunded' : 'refunded';
    payment.refundAmount = refundAmount;
    payment.refundedAt = new Date();
    payment.refundId = resource.id;
    
    // Stocker les métadonnées de façon chiffrée
    payment.paymentMetadata = EncryptionService.encrypt(JSON.stringify({
      isPartialRefund,
      originalAmount: payment.amount,
      refundAmount,
      refundDate: new Date(),
      refundCurrency: resource.amount.currency_code
    }));
    
    await payment.save();
    
    // Si c'est un remboursement complet, rendre le produit à nouveau disponible
    if (!isPartialRefund) {
      await Product.findByIdAndUpdate(payment.product, {
        isAvailable: true,
        isSold: false,
        soldAt: null,
        soldTo: null
      });
    }
    
    // Notifier l'acheteur (RGPD compliant)
    await NotificationService.createNotification({
      recipientId: payment.buyer,
      type: 'system',
      title: isPartialRefund ? 'Remboursement partiel reçu' : 'Remboursement complet reçu',
      content: `Vous avez été remboursé de ${refundAmount} ${resource.amount.currency_code} pour votre achat.`,
      link: `/account/purchases/${payment._id}`,
      data: {
        paymentId: payment._id,
        productId: payment.product,
        refundAmount,
        currency: resource.amount.currency_code,
        isRefund: true
      }
    });
  } catch (error) {
    logger.error('Erreur lors du traitement de l\'événement PAYMENT.CAPTURE.REFUNDED', { error });
    throw error;
  }
}

/**
 * Traite les événements de capture refusée
 */
async function handleCaptureDenied(event: any) {
  try {
    const resource = event.resource;
    const orderId = resource.supplementary_data?.related_ids?.order_id || 
                    resource.invoice_id || 
                    resource.custom_id;
    
    if (!orderId) {
      logger.warn('Impossible de déterminer l\'orderId dans l\'événement de refus', { 
        resourceId: resource.id 
      });
      return;
    }
    
    // Rechercher le paiement correspondant
    const payment = await Payment.findOne({ paymentIntentId: orderId });
    
    if (!payment) {
      logger.warn('Aucun paiement trouvé pour l\'orderId', { orderId });
      return;
    }
    
    // Mettre à jour le statut du paiement
    payment.status = 'failed';
    await payment.save();
    
    // Rendre le produit à nouveau disponible
    await Product.findByIdAndUpdate(payment.product, {
      isAvailable: true,
      isReserved: false,
      reservedFor: null
    });
  } catch (error) {
    logger.error('Erreur lors du traitement de l\'événement PAYMENT.CAPTURE.DENIED', { error });
    throw error;
  }
}

/**
 * Vérifie et met à jour le statut d'un paiement
 */
export const checkPaymentStatus = asyncHandler(async (req: Request, res: Response) => {
  const { paymentId } = req.params;
  
  try {
    // Rechercher le paiement
    const payment = await Payment.findById(paymentId);
    if (!payment) {
      return res.status(404).json({
        success: false,
        message: 'Paiement non trouvé'
      });
    }
    
    // Vérifier le statut auprès de PayPal si le paiement est en attente
    let paypalStatus = '';
    if (payment.status === 'pending') {
      try {
        paypalStatus = await PayPalService.checkPaymentStatus(payment.paymentIntentId);
        
        // Mettre à jour notre base de données si le paiement est APPROVED ou COMPLETED
        if ((paypalStatus === 'APPROVED' || paypalStatus === 'COMPLETED') && payment.status !== 'completed') {
          // Pour les paiements APPROVED, nous devons les capturer pour les finaliser
          if (paypalStatus === 'APPROVED') {
            try {
              logger.info('Tentative de capture du paiement approuvé', {
                paymentId,
                orderId: payment.paymentIntentId
              });
              
              // Capturer le paiement approuvé
              const captureResult = await PayPalService.capturePayment(payment.paymentIntentId);
              if (captureResult.status === 'COMPLETED') {
                // Mise à jour du paiement après une capture réussie
                payment.status = 'completed';
                payment.completedAt = new Date();
                payment.captureId = captureResult.captureId;
                await payment.save();
                
                logger.info('Paiement capturé et marqué comme complété', {
                  paymentId,
                  captureId: captureResult.captureId
                });
                
                // Mise à jour du produit
                await Product.findByIdAndUpdate(payment.product, {
                  isAvailable: false,
                  isReserved: false,
                  isSold: true,
                  soldAt: new Date(),
                  soldTo: payment.buyer
                });
                
                // Notifier le vendeur de la vente
                const product = await Product.findById(payment.product);
                if (product) {
                  await NotificationService.createNotification({
                    recipientId: payment.seller,
                    type: 'system',
                    title: 'Votre article a été vendu !',
                    content: `Le produit "${product.title}" a été vendu pour ${payment.amount} ${payment.currency}.`,
                    link: `/account/sales/${payment._id}`,
                    data: {
                      paymentId: payment._id,
                      productId: payment.product
                    }
                  });
                }
                
                paypalStatus = 'COMPLETED';
              }
            } catch (captureError) {
              logger.error('Erreur lors de la capture du paiement approuvé', {
                error: captureError instanceof Error ? captureError.message : String(captureError),
                paymentId,
                orderId: payment.paymentIntentId
              });
              
              // Si la capture échoue mais que c'est à cause d'un paiement déjà capturé
              // if (captureError.response && captureError.response.data && 
              //     captureError.response.data.name === 'ORDER_ALREADY_CAPTURED') {
              //   // Quand même mettre à jour notre statut local
              //   payment.status = 'completed';
              //   payment.completedAt = new Date();
              //   await payment.save();
                
              //   // Mise à jour du produit quand même
              //   await Product.findByIdAndUpdate(payment.product, {
              //     isAvailable: false,
              //     isReserved: false,
              //     isSold: true,
              //     soldAt: new Date(),
              //     soldTo: payment.buyer
              //   });
                
              //   paypalStatus = 'COMPLETED';
              // }
            }
          } else if (paypalStatus === 'COMPLETED') {
            // Le paiement est déjà complété côté PayPal, mettre à jour notre base
            payment.status = 'completed';
            payment.completedAt = new Date();
            await payment.save();
            
            // Mise à jour du produit
            await Product.findByIdAndUpdate(payment.product, {
              isAvailable: false,
              isReserved: false,
              isSold: true,
              soldAt: new Date(),
              soldTo: payment.buyer
            });
          }
        } else if (paypalStatus === 'VOIDED' || paypalStatus === 'CANCELLED') {
          // Le paiement a été annulé/remboursé côté PayPal
          if (payment.status !== 'cancelled') {
            payment.status = 'cancelled';
            await payment.save();
            
            // Rendre le produit à nouveau disponible
            await Product.findByIdAndUpdate(payment.product, {
              isAvailable: true,
              isReserved: false,
              reservedFor: null
            });
          }
        }
      } catch (statusError) {
        logger.error('Erreur lors de la vérification du statut PayPal', {
          error: statusError instanceof Error ? statusError.message : String(statusError),
          paymentId,
          orderId: payment.paymentIntentId
        });
        // On continue pour renvoyer au moins l'état actuel du paiement
      }
    } else {
      // Pour les paiements déjà traités, utiliser simplement le statut interne
      paypalStatus = payment.status === 'completed' ? 'COMPLETED' : 
                     payment.status === 'refunded' ? 'REFUNDED' : 
                     payment.status === 'partially_refunded' ? 'PARTIALLY_REFUNDED' :
                     payment.status === 'cancelled' ? 'CANCELLED' :
                     'UNKNOWN';
    }
    
    // Préparer la réponse avec toutes les informations pertinentes
    const response: any = {
      success: true,
      payment: {
        id: payment._id,
        paypalOrderId: payment.paymentIntentId,
        status: payment.status,
        paypalStatus: paypalStatus,
        amount: payment.amount,
        currency: payment.currency,
        createdAt: payment.createdAt,
        completedAt: payment.completedAt,
        captureId: payment.captureId
      }
    };
    
    // Ajouter les informations de remboursement si présentes
    if (payment.status === 'partially_refunded' || payment.status === 'refunded') {
      response.payment.refundAmount = payment.refundAmount;
      response.payment.refundedAt = payment.refundedAt;
      response.payment.refundId = payment.refundId;
      
      if (payment.status === 'partially_refunded') {
        response.payment.remainingUnrefunded = (payment.amount - payment.refundAmount).toFixed(2);
      }
    }
    
    // Ajouter les informations du produit et du vendeur
    try {
      const product = await Product.findById(payment.product).select('title images price currency');
      if (product) {
        response.payment.product = {
          id: product._id,
          title: product.title,
          image: product.images && product.images.length > 0 ? product.images[0] : null,
          price: product.price,
          currency: product.currency,
          isSold: product.isSold
        };
      }
    } catch (productError) {
      // Ignorer l'erreur et continuer sans les infos produit
      logger.warn('Erreur lors de la récupération des détails du produit pour le paiement', {
        error: productError instanceof Error ? productError.message : String(productError),
        paymentId,
        productId: payment.product
      });
    }
    
    return res.status(200).json(response);
  } catch (error) {
    logger.error('Erreur lors de la vérification du statut du paiement', { 
      error: error instanceof Error ? error.message : String(error),
      paymentId
    });
    return res.status(500).json({ 
      success: false,
      message: 'Une erreur est survenue lors de la vérification du statut du paiement'
    });
  }
});

/**
 * Effectue un remboursement total ou partiel pour un paiement
 * @route POST /api/payments/:paymentId/refund
 * @access Private - Vendeur uniquement
 */
export const refundPayment = asyncHandler(async (req: Request, res: Response) => {
  const { paymentId } = req.params;
  const { amount, reason } = req.body;
  const userId = (req.user as any).id;
  
  if (!userId) {
    return res.status(401).json({
      success: false,
      message: 'Authentification requise'
    });
  }
  
  try {
    // Récupérer le paiement
    const payment = await Payment.findById(paymentId);
    if (!payment) {
      return res.status(404).json({ 
        success: false,
        message: 'Paiement non trouvé' 
      });
    }
    
    // Vérifier que l'utilisateur est bien le vendeur
    if (payment.seller.toString() !== userId) {
      return res.status(403).json({ 
        success: false,
        message: 'Vous n\'êtes pas autorisé à rembourser ce paiement' 
      });
    }
    
    // Vérifier que le paiement est bien complété
    if (payment.status !== 'completed' && payment.status !== 'partially_refunded') {
      return res.status(400).json({ 
        success: false,
        message: `Impossible de rembourser ce paiement avec le statut "${payment.status}". Seuls les paiements complétés ou partiellement remboursés peuvent être remboursés`
      });
    }
    
    // Vérifier que le paiement n'est pas déjà entièrement remboursé
    if (payment.status === 'refunded') {
      return res.status(400).json({ 
        success: false,
        message: 'Ce paiement a déjà été entièrement remboursé. Aucun remboursement supplémentaire n\'est possible.' 
      });
    }
    
    // Vérifier que le captureId existe
    if (!payment.captureId) {
      return res.status(400).json({ 
        success: false,
        message: 'Impossible de rembourser ce paiement : ID de capture manquant. Veuillez contacter le support.' 
      });
    }
    
    // Traitement pour remboursement partiel ou complet
    const isPartialRefund = !!amount && amount > 0 && amount < payment.amount;
    let refundAmount = null;
    
    // Pour un remboursement partiel, valider le montant
    if (isPartialRefund) {
      refundAmount = parseFloat(amount.toString());
      
      // Vérifier que le montant est un nombre valide
      if (isNaN(refundAmount) || refundAmount <= 0) {
        return res.status(400).json({ 
          success: false,
          message: 'Le montant du remboursement doit être un nombre positif' 
        });
      }
      
      // Vérifier que le montant est inférieur au montant total
      if (refundAmount >= payment.amount) {
        return res.status(400).json({ 
          success: false,
          message: `Pour un remboursement partiel, le montant (${refundAmount.toFixed(2)} ${payment.currency}) doit être inférieur au montant total (${payment.amount.toFixed(2)} ${payment.currency})` 
        });
      }
      
      // Vérifier si un remboursement partiel a déjà été fait
      if (payment.status === 'partially_refunded') {
        const alreadyRefunded = payment.refundAmount || 0;
        if (alreadyRefunded + refundAmount > payment.amount) {
          return res.status(400).json({ 
            success: false,
            message: `Le montant total remboursé dépasserait le montant initial. Déjà remboursé: ${alreadyRefunded.toFixed(2)} ${payment.currency}. Montant maximum pour ce remboursement: ${(payment.amount - alreadyRefunded).toFixed(2)} ${payment.currency}` 
          });
        }
      }
    }
    
    logger.info('Tentative de remboursement', { 
      paymentId, 
      captureId: payment.captureId, 
      isPartial: isPartialRefund,
      amount: isPartialRefund ? refundAmount : 'complet'
    });
    
    // Effectuer le remboursement avec PayPal
    const refundResult = await PayPalService.refundConnectedPayment(
      payment.captureId,
      isPartialRefund ? refundAmount : null, // null pour un remboursement complet
      reason || 'Remboursement effectué par le vendeur',
      userId
    );
    
    // Mettre à jour le statut du paiement
    const currentRefundAmount = payment.refundAmount || 0;
    const newRefundAmount = isPartialRefund 
      ? currentRefundAmount + refundAmount
      : payment.amount;
    
    payment.status = isPartialRefund ? 'partially_refunded' : 'refunded';
    payment.refundAmount = newRefundAmount;
    payment.refundedAt = new Date();
    payment.refundId = refundResult.id;
    await payment.save();
    
    // Si c'est un remboursement complet, remettre le produit comme disponible
    if (!isPartialRefund) {
      await Product.findByIdAndUpdate(payment.product, {
        isAvailable: true,
        isReserved: false,
        isSold: false,
        soldAt: null,
        soldTo: null
      });
    }
    
    // Notifier l'acheteur
    await NotificationService.createNotification({
      recipientId: payment.buyer,
      type: 'system',
      title: isPartialRefund ? 'Remboursement partiel reçu' : 'Remboursement complet reçu',
      content: `Vous avez été remboursé de ${isPartialRefund && refundAmount !== null ? refundAmount.toFixed(2) : payment.amount.toFixed(2)} ${payment.currency} pour votre achat.`,
      link: `/account/purchases/${payment._id}`,
      data: {
        paymentId: payment._id,
        productId: payment.product,
        refundAmount: isPartialRefund && refundAmount !== null ? refundAmount : payment.amount,
        currency: payment.currency,
        isRefund: true
      }
    });
    
    // Ensure we have a valid refundAmount for partial refunds before formatting
    const formattedAmount = isPartialRefund && refundAmount !== null 
      ? refundAmount.toFixed(2) 
      : payment.amount.toFixed(2);
      
    return res.status(200).json({
      success: true,
      message: isPartialRefund 
        ? `Remboursement partiel de ${formattedAmount} ${payment.currency} effectué avec succès` 
        : `Remboursement complet de ${payment.amount.toFixed(2)} ${payment.currency} effectué avec succès`,
      refund: {
        id: refundResult.id,
        status: refundResult.status,
        amount: formattedAmount,
        currency: payment.currency,
        createdAt: refundResult.createdAt || new Date(),
        remainingUnrefunded: isPartialRefund ? (payment.amount - newRefundAmount).toFixed(2) : "0.00"
      }
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    logger.error('Erreur lors du remboursement', { 
      error: errorMessage,
      paymentId,
      userId: userId.substring(0, 5) + '...'
    });
    
    // Gestion des erreurs spécifiques PayPal
    if (errorMessage.includes('ALREADY_REFUNDED') || errorMessage.includes('already been refunded')) {
      return res.status(400).json({ 
        success: false,
        message: 'Ce paiement a déjà été entièrement remboursé par PayPal', 
        code: 'ALREADY_REFUNDED'
      });
    }
    
    if (errorMessage.includes('TRANSACTION_REFUSED')) {
      return res.status(400).json({ 
        success: false,
        message: 'PayPal a refusé cette transaction de remboursement. Veuillez contacter le support PayPal.', 
        code: 'TRANSACTION_REFUSED'
      });
    }
    
    return res.status(500).json({ 
      success: false,
      message: 'Une erreur est survenue lors du remboursement',
      error: process.env.NODE_ENV === 'development' ? errorMessage : undefined
    });
  }
});

/**
 * Récupère la liste des paiements de l'utilisateur
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
      
      // Supprimer les données techniques et personnelles sensibles
      delete paymentObj.ipAddress;
      delete paymentObj.userAgent;
      
      // Déchiffrer les métadonnées si présentes
      if (paymentObj.paymentMetadata) {
        try {
          (paymentObj as any).metadata = JSON.parse(EncryptionService.decrypt(paymentObj.paymentMetadata));
          delete paymentObj.paymentMetadata;
        } catch (error) {
          logger.warn('Erreur lors du déchiffrement des métadonnées', { 
            error: error instanceof Error ? error.message : String(error), 
            paymentId: payment._id 
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
    logger.error('Erreur lors de la récupération des paiements', { 
      error: error instanceof Error ? error.message : String(error),
      userId: userId.substring(0, 5) + '...'
    });
    return res.status(500).json({ 
      message: 'Une erreur est survenue lors de la récupération des paiements',
      error: process.env.NODE_ENV === 'development' 
        ? (error instanceof Error ? error.message : String(error)) 
        : undefined
    });
  }
});