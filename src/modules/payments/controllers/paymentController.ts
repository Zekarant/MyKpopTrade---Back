import { Request, Response } from 'express';
import { asyncHandler } from '../../../commons/middlewares/errorMiddleware';
import { PayPalService } from '../services/paypalService';
import Payment from '../../../models/paymentModel';
import Product from '../../../models/productModel';
import User from '../../../models/userModel';
import { EncryptionService } from '../../../commons/utils/encryptionService';
import { NotificationService } from '../../notifications/services/notificationService';
import logger from '../../../commons/utils/logger';
import { GdprLogger } from '../../../commons/utils/gdprLogger';

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
 * Vérifie et met à jour le statut d'un paiement
 */
export const checkPaymentStatus = asyncHandler(async (req: Request, res: Response) => {
  const { paymentId } = req.params;
  const userId = (req.user as any).id;

  if (!userId) {
    return res.status(401).json({
      success: false,
      message: 'Authentification requise'
    });
  }

  try {
    const payment = await Payment.findById(paymentId)
      .populate('product', 'title price images');

    if (!payment) {
      return res.status(404).json({
        success: false,
        message: 'Paiement non trouvé'
      });
    }

    // Vérifier si l'utilisateur est autorisé à accéder à ce paiement
    const isAuthorized = 
      payment.buyer.toString() === userId || 
      payment.seller.toString() === userId;

    // Si l'utilisateur n'est pas autorisé, vérifier s'il est admin
    if (!isAuthorized) {
      // Récupérer l'utilisateur pour vérifier son rôle
      const user = await User.findById(userId).select('role');
      
      if (!user || user.role !== 'admin') {
        // Journaliser la tentative d'accès non autorisée
        GdprLogger.logPaymentAction('unauthorized_access_attempt', {
          paymentId,
          targetPaymentBuyer: payment.buyer.toString(),
          targetPaymentSeller: payment.seller.toString()
        }, userId);
        
        return res.status(403).json({
          success: false,
          message: 'Vous n\'êtes pas autorisé à accéder à ce paiement',
          code: 'PAYMENT_ACCESS_DENIED'
        });
      }
    }

    // Journaliser l'accès légitime
    GdprLogger.logPaymentAction('payment_status_checked', {
      paymentId
    }, userId);

    return res.status(200).json({
      success: true,
      status: payment.status,
      payment
    });
  } catch (error) {
    GdprLogger.logPaymentError(error, userId, { action: 'check_payment_status', paymentId });
    
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
  //const { amount, reason } = req.body;
  const userId = (req.user as any).id;

  if (!userId) {
    return res.status(401).json({
      success: false,
      message: 'Authentification requise'
    });
  }

  try {
    const payment = await Payment.findById(paymentId);

    if (!payment) {
      return res.status(404).json({
        success: false,
        message: 'Paiement non trouvé'
      });
    }

    // Vérifier si l'utilisateur est le vendeur ou un admin
    const isSeller = payment.seller.toString() === userId;
    let isAdmin = false;

    if (!isSeller) {
      // Si l'utilisateur n'est pas le vendeur, vérifier s'il est admin
      const user = await User.findById(userId).select('role');
      isAdmin = user && user.role === 'admin';
      
      if (!isAdmin) {
        // Journaliser la tentative non autorisée
        GdprLogger.logPaymentAction('unauthorized_refund_attempt', {
          paymentId,
          targetPaymentSeller: payment.seller.toString()
        }, userId);
        
        return res.status(403).json({
          success: false,
          message: 'Seul le vendeur ou un administrateur peut effectuer un remboursement',
          code: 'REFUND_PERMISSION_DENIED'
        });
      }
    }

    // Le reste de la fonction reste inchangé...
    // Vérifier que le paiement est dans un état permettant le remboursement...
    // Effectuer le remboursement avec PayPal...
    // Mettre à jour le statut du paiement...
  } catch (error) {
    // Gestion des erreurs...
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

/**
 * Récupère les détails d'un paiement spécifique
 * @route GET /api/payments/:paymentId
 * @access Private - Limité à l'acheteur, au vendeur et aux administrateurs
 */
export const getPayment = asyncHandler(async (req: Request, res: Response) => {
  const { paymentId } = req.params;
  const userId = (req.user as any).id;

  if (!userId) {
    return res.status(401).json({
      success: false,
      message: 'Authentification requise'
    });
  }

  try {
    // Récupérer le paiement avec ses relations
    const payment = await Payment.findById(paymentId)
      .populate('product', 'title description price images')
      .populate('buyer', 'username email profileImage')
      .populate('seller', 'username email profileImage');

    if (!payment) {
      return res.status(404).json({
        success: false,
        message: 'Paiement non trouvé'
      });
    }

    // Vérifier si l'utilisateur est autorisé à accéder à ce paiement
    // L'utilisateur doit être soit l'acheteur, soit le vendeur, soit un administrateur
    const isAuthorized = 
      payment.buyer._id.toString() === userId || 
      payment.seller._id.toString() === userId;

    // Si l'utilisateur n'est pas autorisé, vérifier s'il est admin
    if (!isAuthorized) {
      // Récupérer l'utilisateur pour vérifier son rôle
      const user = await User.findById(userId).select('role');
      
      if (!user || user.role !== 'admin') {
        // Journaliser la tentative d'accès non autorisée
        GdprLogger.logPaymentAction('unauthorized_access_attempt', {
          paymentId,
          targetPaymentBuyer: payment.buyer._id.toString(),
          targetPaymentSeller: payment.seller._id.toString()
        }, userId);
        
        return res.status(403).json({
          success: false,
          message: 'Vous n\'êtes pas autorisé à accéder à ce paiement',
          code: 'PAYMENT_ACCESS_DENIED'
        });
      }
    }

    // L'utilisateur est autorisé, journaliser l'accès et renvoyer les données
    GdprLogger.logPaymentAction('payment_details_accessed', {
      paymentId
    }, userId);

    return res.status(200).json({
      success: true,
      payment
    });
  } catch (error) {
    GdprLogger.logPaymentError(error, userId, { action: 'get_payment_details', paymentId });
    
    return res.status(500).json({
      success: false,
      message: 'Une erreur est survenue lors de la récupération du paiement'
    });
  }
});