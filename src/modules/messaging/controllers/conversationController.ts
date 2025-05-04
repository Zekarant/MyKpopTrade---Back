import { Request, Response } from 'express';
import { asyncHandler } from '../../../commons/middlewares/errorMiddleware';
import Conversation from '../../../models/conversationModel';
import Message from '../../../models/messageModel';
import Product from '../../../models/productModel';
import User from '../../../models/userModel';
import { 
  createConversation, 
  getConversationMessages 
} from '../services/messageService';
import { 
  startNegotiation, 
  respondToOffer, 
  startPayWhatYouWant,
  makePayWhatYouWantOffer 
} from '../services/negotiationService';
import logger from '../../../commons/utils/logger';

/**
 * Récupère la liste des conversations d'un utilisateur
 */
export const getUserConversations = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 10;
  const filter = req.query.filter as string || 'all'; // all, unread, active
  
  const query: any = {
    participants: userId,
    isActive: true
  };
  
  if (filter === 'unread') {
    // Complexité: trouver les conversations avec des messages non lus
    const conversationsWithUnreadMessages = await Message.distinct('conversation', {
      conversation: { $in: await Conversation.find({ participants: userId }).distinct('_id') },
      readBy: { $ne: userId },
      isDeleted: false
    });
    
    query._id = { $in: conversationsWithUnreadMessages };
  }
  
  // Compter le total de conversations
  const total = await Conversation.countDocuments(query);
  
  // Récupérer les conversations avec pagination et tri par dernier message
  const conversations = await Conversation.find(query)
    .sort({ lastMessageAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .populate('participants', 'username profilePicture')
    .populate('productId', 'title price images')
    .lean();
  
  // Calculer le nombre de messages non lus pour chaque conversation
  const conversationsWithUnreadCount = await Promise.all(conversations.map(async (conversation) => {
    const unreadCount = await Message.countDocuments({
      conversation: conversation._id,
      sender: { $ne: userId },
      readBy: { $ne: userId },
      isDeleted: false
    });
    
    // Récupérer le dernier message pour l'aperçu
    const lastMessage = await Message.findOne({ 
      conversation: conversation._id,
      isDeleted: false 
    })
      .sort({ createdAt: -1 })
      .select('content contentType sender createdAt isEncrypted')
      .populate('sender', 'username')
      .lean();
    
    // Préparer un aperçu du message en fonction de son type
    let messagePreview = '';
    if (lastMessage && !Array.isArray(lastMessage)) {
      if (lastMessage.isEncrypted) {
        messagePreview = '[Message chiffré]';
      } else if (lastMessage.contentType === 'system_notification') {
        messagePreview = lastMessage.content;
      } else if (lastMessage.contentType === 'offer' || lastMessage.contentType === 'counter_offer') {
        messagePreview = lastMessage.content;
      } else {
        // Limiter l'aperçu à 50 caractères
        messagePreview = lastMessage.content.length > 50 
          ? lastMessage.content.substring(0, 50) + '...'
          : lastMessage.content;
      }
    }
    
    return {
      ...conversation,
      unreadCount,
      lastMessage: lastMessage ? {
        ...lastMessage,
        preview: messagePreview
      } : null,
      // Déterminer l'autre participant (pour les conversations à deux participants)
      otherParticipant: conversation.participants.length === 2
        ? conversation.participants.find((p: any) => p._id.toString() !== userId)
        : null
    };
  }));
  
  return res.status(200).json({
    conversations: conversationsWithUnreadCount,
    pagination: {
      total,
      page,
      limit,
      pages: Math.ceil(total / limit)
    }
  });
});

/**
 * Récupère une conversation spécifique avec ses messages
 */
export const getConversation = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const conversationId = req.params.id;
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;
  
  // Vérifier l'accès à la conversation
  const conversation = await Conversation.findOne({
    _id: conversationId,
    participants: userId
  })
    .populate('participants', 'username profilePicture email')
    .populate('productId', 'title price images seller')
    .lean() as any; // Using type assertion to fix the TypeScript error
  
  if (!conversation) {
    return res.status(404).json({ message: 'Conversation non trouvée' });
  }
  
  // Si la conversation concerne un produit, vérifier si l'utilisateur est le vendeur
  if (conversation.productId) {
    conversation.isOwner = conversation.productId.seller.toString() === userId;
  }
  
  // Récupérer les messages avec pagination
  const result = await getConversationMessages({
    conversationId,
    userId,
    page,
    limit
  });
  
  return res.status(200).json({
    conversation,
    messages: result.messages,
    pagination: result.pagination
  });
});

/**
 * Crée une nouvelle conversation
 */
export const startConversation = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const { recipientId, productId, initialMessage, type = 'general' } = req.body;
  
  if (!recipientId) {
    return res.status(400).json({ message: 'Destinataire requis' });
  }
  
  if (recipientId === userId) {
    return res.status(400).json({ message: 'Vous ne pouvez pas créer une conversation avec vous-même' });
  }
  
  // Vérifier si le destinataire existe
  const recipient = await User.findById(recipientId);
  if (!recipient) {
    return res.status(404).json({ message: 'Destinataire non trouvé' });
  }
  
  // Vérifier les autorisations de messages directs du destinataire
  if (!recipient.preferences?.allowDirectMessages && type === 'general') {
    return res.status(403).json({ 
      message: 'Ce membre n\'accepte pas les messages directs' 
    });
  }
  
  // Si c'est une discussion sur un produit, vérifier qu'il existe
  if (productId) {
    const product = await Product.findById(productId);
    if (!product) {
      return res.status(404).json({ message: 'Produit non trouvé' });
    }
    
    // Vérifier que l'utilisateur n'est pas le vendeur du produit
    if (product.seller.toString() === userId && type !== 'pay_what_you_want') {
      return res.status(400).json({ 
        message: 'Vous ne pouvez pas créer une conversation sur votre propre produit' 
      });
    }
    
    // Vérifier que le destinataire est bien le vendeur du produit
    if (product.seller.toString() !== recipientId && type !== 'pay_what_you_want') {
      return res.status(400).json({ 
        message: 'Le destinataire n\'est pas le vendeur de ce produit' 
      });
    }
  }
  
  try {
    // Créer la conversation
    const participants = [userId, recipientId];
    const conversation = await createConversation({
      participants,
      productId,
      type,
      createdBy: userId
    });
    
    // Envoyer le message initial si fourni
    if (initialMessage && initialMessage.trim()) {
      const messageService = require('../services/messageService');
      await messageService.sendMessage({
        conversationId: conversation._id,
        senderId: userId,
        content: initialMessage,
        contentType: 'text'
      });
    }
    
    return res.status(201).json({
      message: 'Conversation créée avec succès',
      conversation
    });
  } catch (error: any) {
    logger.error('Erreur lors de la création d\'une conversation', { error });
    return res.status(500).json({ message: error.message });
  }
});

/**
 * Initie une négociation sur un produit
 */
export const initiateNegotiation = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const { productId, initialOffer, message } = req.body;
  
  if (!productId) {
    return res.status(400).json({ message: 'ID du produit requis' });
  }
  
  if (!initialOffer || isNaN(parseFloat(initialOffer)) || parseFloat(initialOffer) <= 0) {
    return res.status(400).json({ message: 'Offre initiale invalide' });
  }
  
  try {
    const result = await startNegotiation({
      productId,
      buyerId: userId,
      initialOffer: parseFloat(initialOffer),
      message: message || ''
    });
    
    return res.status(201).json({
      message: 'Négociation initiée avec succès',
      negotiation: result
    });
  } catch (error: any) {
    logger.error('Erreur lors de l\'initiation d\'une négociation', { error });
    return res.status(400).json({ message: error.message });
  }
});

/**
 * Répond à une offre de négociation
 */
export const respondToNegotiation = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const conversationId = req.params.id;
  const { action, counterOffer, message } = req.body;
  
  if (!['accept', 'counter', 'reject'].includes(action)) {
    return res.status(400).json({ message: 'Action non reconnue' });
  }
  
  if (action === 'counter' && (!counterOffer || isNaN(parseFloat(counterOffer)) || parseFloat(counterOffer) <= 0)) {
    return res.status(400).json({ message: 'Contre-offre invalide' });
  }
  
  try {
    const result = await respondToOffer({
      conversationId,
      userId,
      action,
      counterOffer: action === 'counter' ? parseFloat(counterOffer) : undefined,
      message: message || ''
    });
    
    return res.status(200).json({
      message: `Offre ${action === 'accept' ? 'acceptée' : action === 'counter' ? 'contre-proposée' : 'rejetée'} avec succès`,
      result
    });
  } catch (error: any) {
    logger.error('Erreur lors de la réponse à une offre', { error });
    return res.status(400).json({ message: error.message });
  }
});

/**
 * Initie une offre Pay What You Want sur un produit
 */
export const initiatePayWhatYouWant = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const { productId, minimumPrice, maximumPrice, message } = req.body;
  
  if (!productId) {
    return res.status(400).json({ message: 'ID du produit requis' });
  }
  
  if (isNaN(parseFloat(minimumPrice)) || parseFloat(minimumPrice) < 0) {
    return res.status(400).json({ message: 'Prix minimum invalide' });
  }
  
  if (maximumPrice && (isNaN(parseFloat(maximumPrice)) || parseFloat(maximumPrice) <= parseFloat(minimumPrice))) {
    return res.status(400).json({ message: 'Prix maximum invalide' });
  }
  
  try {
    const result = await startPayWhatYouWant({
      productId,
      sellerId: userId,
      minimumPrice: parseFloat(minimumPrice),
      maximumPrice: maximumPrice ? parseFloat(maximumPrice) : undefined,
      message: message || ''
    });
    
    return res.status(201).json({
      message: 'Option Pay What You Want activée avec succès',
      payWhatYouWant: result
    });
  } catch (error: any) {
    logger.error('Erreur lors de l\'activation de Pay What You Want', { error });
    return res.status(400).json({ message: error.message });
  }
});

/**
 * Fait une proposition dans une conversation Pay What You Want
 */
export const makePayWhatYouWantProposal = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const conversationId = req.params.id;
  const { proposedPrice, message } = req.body;
  
  if (!proposedPrice || isNaN(parseFloat(proposedPrice)) || parseFloat(proposedPrice) <= 0) {
    return res.status(400).json({ message: 'Prix proposé invalide' });
  }
  
  try {
    const result = await makePayWhatYouWantOffer({
      conversationId,
      buyerId: userId,
      proposedPrice: parseFloat(proposedPrice),
      message: message || ''
    });
    
    return res.status(200).json({
      message: 'Proposition de prix envoyée avec succès',
      result
    });
  } catch (error: any) {
    logger.error('Erreur lors de la proposition d\'un prix PWYW', { error });
    return res.status(400).json({ message: error.message });
  }
});