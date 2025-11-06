import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { asyncHandler } from '../../../commons/middlewares/errorMiddleware';
import Conversation from '../../../models/conversationModel';
import Message from '../../../models/messageModel';
import User from '../../../models/userModel';
import Product from '../../../models/productModel';
import { MessagingUtilsService } from '../services/messagingUtilsService';
import logger from '../../../commons/utils/logger';
import {
  startPayWhatYouWant,
  makePayWhatYouWantOffer
} from '../services/negotiationService';
import { LeanConversation } from '../types/conversationTypes';

/**
 * Récupère une conversation spécifique avec ses messages
 */
export const getConversation = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const conversationId = req.params.id;
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;

  try {
    await MessagingUtilsService.verifyConversationAccess(conversationId, userId);

    // Récupérer la conversation
    const conversationRaw = await Conversation.findById(conversationId)
      .populate('participants', 'username profilePicture email location bio preferences socialLinks statistics')
      .populate({
        path: 'productId',
        select: 'title description price images seller category condition kpopGroup kpopMember albumName currency isAvailable allowOffers minOfferPercentage shippingOptions createdAt'
      })
      .populate('offerHistory.offeredBy', 'username profilePicture')
      .lean();

    if (!conversationRaw) {
      return res.status(404).json({ message: 'Conversation non trouvée' });
    }

    const conversation = conversationRaw as LeanConversation;

    // Enrichir les données produit si présent
    if (conversation.productId) {
      (conversation as any).isOwner = conversation.productId.seller.toString() === userId;

      if (conversation.productId.category) {
        conversation.productId.categoryLabel = MessagingUtilsService.formatCategory(conversation.productId.category);
      }
    }

    // Ajouter les métadonnées utilisateur
    const isArchived = Array.isArray(conversation.archivedBy) &&
      conversation.archivedBy.some((id: any) => id.toString() === userId);
    const isFavorited = Array.isArray(conversation.favoritedBy) &&
      conversation.favoritedBy.some((id: any) => id.toString() === userId);

    (conversation as any).userMetadata = {
      isArchived,
      isFavorited
    };

    // Formater l'historique des offres
    if (Array.isArray(conversation.offerHistory) && conversation.offerHistory.length > 0) {
      (conversation as any).formattedOfferHistory = conversation.offerHistory.map((offer: any) => ({
        ...offer,
        isCurrentUserOffer: offer.offeredBy?._id?.toString() === userId,
        formattedAmount: `${offer.amount} ${conversation.productId?.currency || 'EUR'}`
      }));
    }

    // Récupérer les messages
    const messageQuery = {
      conversation: new mongoose.Types.ObjectId(conversationId),
      isDeleted: false,
      isActive: true
    };

    const totalMessages = await Message.countDocuments(messageQuery);

    const messages = await Message.find(messageQuery)
      .sort({ createdAt: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('sender', 'username profilePicture')
      .lean();

    const markedCount = await MessagingUtilsService.markConversationAsRead(conversationId, userId);

    // Récupérer les médias
    const mediaQuery = {
      conversation: new mongoose.Types.ObjectId(conversationId),
      attachments: { $exists: true, $ne: [] },
      isDeleted: false
    };

    const mediaMessages = await Message.find(mediaQuery)
      .select('attachments createdAt sender')
      .populate('sender', 'username profilePicture')
      .sort({ createdAt: -1 })
      .lean();

    const media = MessagingUtilsService.formatConversationMedia(mediaMessages);

    return res.status(200).json({
      conversation,
      messages,
      media,
      markedAsRead: markedCount,
      offersSummary: (conversation.type === 'negotiation' || conversation.type === 'pay_what_you_want') ? {
        totalOffers: conversation.offerHistory.length,
        currentStatus: conversation.type === 'negotiation'
          ? conversation.negotiation?.status
          : conversation.payWhatYouWant?.status,
        latestOffer: conversation.offerHistory[0] || null
      } : null,
      pagination: {
        total: totalMessages,
        page,
        limit,
        pages: Math.ceil(totalMessages / limit)
      }
    });
  } catch (error) {
    logger.error('Erreur lors de la récupération de la conversation', { error, conversationId, userId });
    return res.status(500).json({
      message: error instanceof Error ? error.message : 'Une erreur est survenue'
    });
  }
});

/**
 * Récupère la liste des conversations d'un utilisateur
 */
export const getUserConversations = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 10;
  const filter = req.query.filter as string || 'all';

  const query: any = {
    participants: userId,
    isActive: true,
    deletedBy: { $ne: userId }
  };

  if (filter === 'unread') {
    const conversationsWithUnreadMessages = await Message.distinct('conversation', {
      conversation: { $in: await Conversation.find({ participants: userId }).distinct('_id') },
      readBy: { $ne: userId },
      isDeleted: false
    });
    query._id = { $in: conversationsWithUnreadMessages };
  } else if (filter === 'archived') {
    query.archivedBy = userId;
  } else if (filter === 'favorites') {
    query.favoritedBy = userId;
  } else if (filter === 'active') {
    query.archivedBy = { $ne: userId };
  }

  const total = await Conversation.countDocuments(query);

  const conversationsRaw = await Conversation.find(query)
    .sort({ lastMessageAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .populate('participants', 'username profilePicture location bio preferences socialLinks statistics')
    .populate('productId', 'title price images currency')
    .lean();

  const conversations = conversationsRaw as LeanConversation[];

  const conversationsWithMetadata = await Promise.all(conversations.map(async (conversation) => {
    const unreadCount = await Message.countDocuments({
      conversation: conversation._id,
      sender: { $ne: userId },
      readBy: { $ne: userId },
      isDeleted: false
    });

    const lastMessage = await Message.findOne({
      conversation: conversation._id,
      isDeleted: false
    })
      .sort({ createdAt: -1 })
      .select('content contentType sender createdAt isEncrypted')
      .populate('sender', 'username')
      .lean();

    let messagePreview = '';
    if (lastMessage && !Array.isArray(lastMessage)) {
      messagePreview = MessagingUtilsService.generateMessagePreview(lastMessage);
    }

    const isArchived = Array.isArray(conversation.archivedBy) &&
      conversation.archivedBy.some((id: any) => id.toString() === userId);
    const isFavorited = Array.isArray(conversation.favoritedBy) &&
      conversation.favoritedBy.some((id: any) => id.toString() === userId);
    const hasActiveOffer = conversation.type === 'negotiation' &&
      conversation.negotiation?.status === 'pending';

    return {
      ...conversation,
      unreadCount,
      lastMessage: lastMessage ? {
        ...lastMessage,
        preview: messagePreview
      } : null,
      otherParticipant: Array.isArray(conversation.participants) && conversation.participants.length === 2
        ? conversation.participants.find((p: any) => p._id.toString() !== userId)
        : null,
      metadata: {
        isArchived,
        isFavorited,
        hasActiveOffer,
        offerCount: Array.isArray(conversation.offerHistory) ? conversation.offerHistory.length : 0
      }
    };
  }));

  return res.status(200).json({
    conversations: conversationsWithMetadata,
    pagination: {
      total,
      page,
      limit,
      pages: Math.ceil(total / limit)
    }
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

  // Vérifier si un produit est spécifié et existe
  if (productId) {
    const product = await Product.findById(productId);
    if (!product) {
      return res.status(404).json({ message: 'Produit non trouvé' });
    }
  }

  try {
    // Vérifier si une conversation existe déjà entre ces utilisateurs (et éventuellement pour ce produit)
    const query: any = {
      participants: { $all: [userId, recipientId] },
      type
    };

    // Si un produit est spécifié, l'ajouter à la requête
    if (productId) {
      query.productId = productId;
    }

    let conversation = await Conversation.findOne(query);

    if (!conversation) {
      // Créer une conversation sans lastMessage pour l'instant
      conversation = await Conversation.create({
        participants: [userId, recipientId],
        type,
        productId: productId || null,
        createdBy: userId
        // Ne pas inclure lastMessage ici
      });
    }

    // Créer le message initial séparément
    if (initialMessage) {
      const message = await Message.create({
        conversation: conversation._id,
        sender: userId,
        content: initialMessage,
        contentType: 'text'
      });

      // Mettre à jour la conversation avec le dernier message après sa création
      // Utiliser findByIdAndUpdate au lieu de la méthode save()
      await Conversation.findByIdAndUpdate(
        conversation._id,
        {
          lastMessage: message._id,
          updatedAt: new Date()
        }
      );

      // Récupérer la conversation mise à jour
      conversation = await Conversation.findById(conversation._id);
    }

    // Récupérer la conversation complète avec les participants
    const populatedConversation = await Conversation.findById(conversation._id)
      .populate('participants', 'username profilePicture email')
      .populate('productId', 'title price images')
      .populate('lastMessage');

    return res.status(201).json({
      message: 'Conversation créée avec succès',
      conversation: populatedConversation
    });
  } catch (error) {
    // Améliorer la journalisation des erreurs pour faciliter le débogage
    if (error instanceof Error) {
      logger.error('Erreur lors de la création de la conversation', {
        error: error.message,
        stack: error.stack,
        path: (error as any).path // Pour capturer le champ problématique
      });
    } else {
      logger.error('Erreur inconnue lors de la création de la conversation', { error });
    }

    return res.status(500).json({
      message: 'Une erreur est survenue lors de la création de la conversation',
      error: process.env.NODE_ENV === 'development' ? {
        message: error instanceof Error ? error.message : 'Erreur inconnue',
        path: (error as any).path
      } : undefined
    });
  }
});

/**
 * Initie une négociation pour un produit
 */
export const initiateNegotiation = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const { productId, initialOffer, message } = req.body;

  // Validation des entrées
  if (!productId || !initialOffer) {
    return res.status(400).json({ message: 'ID du produit et offre initiale requis' });
  }

  if (typeof initialOffer !== 'number' || initialOffer <= 0) {
    return res.status(400).json({ message: 'L\'offre doit être un nombre positif' });
  }

  try {
    // Récupérer le produit
    const product = await Product.findById(productId);

    if (!product) {
      return res.status(404).json({ message: 'Produit non trouvé' });
    }

    if (!product.isAvailable) {
      return res.status(400).json({ message: 'Ce produit n\'est plus disponible' });
    }

    if (!product.allowOffers) {
      return res.status(400).json({ message: 'Ce produit n\'accepte pas les offres' });
    }

    // Vérifier que l'utilisateur n'est pas le vendeur
    if (product.seller.toString() === userId) {
      return res.status(400).json({ message: 'Vous ne pouvez pas faire une offre sur votre propre produit' });
    }

    // Vérifier que l'offre est supérieure au pourcentage minimum
    const minOffer = product.price * (product.minOfferPercentage || 50) / 100;
    if (initialOffer < minOffer) {
      return res.status(400).json({
        message: `L'offre doit être au moins ${product.minOfferPercentage || 50}% du prix (${minOffer} ${product.currency})`
      });
    }

    // Vérifier si une négociation existe déjà pour cet utilisateur et ce produit
    let existingNegotiation = product.negotiations?.find((n: any) =>
      n.buyer.toString() === userId && ['pending', 'accepted'].includes(n.status)
    );

    // Si une négociation existe déjà, rediriger vers la conversation existante
    if (existingNegotiation && existingNegotiation.conversationId) {
      const conversation = await Conversation.findById(existingNegotiation.conversationId)
        .populate('participants', 'username profilePicture email');

      return res.status(200).json({
        message: 'Une négociation existe déjà pour ce produit',
        negotiation: existingNegotiation,
        conversation
      });
    }

    // Créer une nouvelle conversation de type négociation AVEC offerHistory
    const conversation = await Conversation.create({
      participants: [userId, product.seller],
      type: 'negotiation',
      productId: product._id,
      createdBy: userId,
      status: 'open',
      negotiation: {
        initialPrice: product.price,
        currentOffer: initialOffer,
        status: 'pending'
      },
      title: `Négociation pour ${product.title}`,
      offerHistory: [{
        offeredBy: userId,
        amount: initialOffer,
        offerType: 'initial',
        status: 'pending',
        message: message || '',
        createdAt: new Date()
      }]
    });

    // Créer un message système pour l'offre initiale
    const systemMessage = await Message.create({
      conversation: conversation._id,
      sender: userId,
      content: `Offre initiale de ${initialOffer} ${product.currency}`,
      contentType: 'offer',
      isSystemMessage: true,
      readBy: [userId]
    });

    // Créer un message avec le texte de l'acheteur si fourni
    if (message && message.trim()) {
      const userMessage = await Message.create({
        conversation: conversation._id,
        sender: userId,
        content: message,
        contentType: 'text',
        readBy: [userId]
      });

      // Mettre à jour la conversation avec le dernier message
      await Conversation.findByIdAndUpdate(
        conversation._id,
        { lastMessage: userMessage._id, lastMessageAt: new Date() }
      );
    } else {
      // Utiliser le message système comme dernier message
      await Conversation.findByIdAndUpdate(
        conversation._id,
        { lastMessage: systemMessage._id, lastMessageAt: new Date() }
      );
    }

    // Ajouter la négociation au produit
    const negotiation = {
      buyer: userId,
      initialOffer,
      currentOffer: initialOffer,
      status: 'pending',
      conversationId: conversation._id,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    // Utiliser $push pour ajouter à l'array de négociations
    await Product.findByIdAndUpdate(
      productId,
      { $push: { negotiations: negotiation } }
    );

    // Récupérer la conversation complète avec les relations
    const populatedConversation = await Conversation.findById(conversation._id)
      .populate('participants', 'username profilePicture email')
      .populate('productId', 'title price images')
      .populate('lastMessage')
      .populate('offerHistory.offeredBy', 'username profilePicture'); // ✅ Peupler l'historique

    return res.status(201).json({
      message: 'Négociation initiée avec succès',
      conversation: populatedConversation,
      initialOffer
    });
  } catch (error) {
    logger.error('Erreur lors de l\'initiation d\'une négociation', {
      error: error instanceof Error ? error.message : 'Erreur inconnue',
      stack: error instanceof Error ? error.stack : undefined,
      productId,
      userId,
      initialOffer
    });

    return res.status(500).json({
      message: 'Une erreur est survenue lors de la création de la négociation'
    });
  }
});

/**
 * Répond à une négociation (accept, reject, counter)
 */
export const respondToNegotiation = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const conversationId = req.params.id;
  const { action, counterOffer, message } = req.body;

  // Validation des entrées
  if (!action || !['accept', 'reject', 'counter'].includes(action)) {
    return res.status(400).json({ message: 'Action invalide. Doit être accept, reject ou counter' });
  }

  if (action === 'counter' && (!counterOffer || typeof counterOffer !== 'number' || counterOffer <= 0)) {
    return res.status(400).json({ message: 'Contre-offre requise et doit être un nombre positif' });
  }

  try {
    // Récupérer la conversation avec les détails du produit
    const conversation = await Conversation.findById(conversationId)
      .populate({
        path: 'productId',
        select: 'title price images seller negotiations currency'
      });

    if (!conversation) {
      return res.status(404).json({ message: 'Conversation non trouvée' });
    }

    if (conversation.type !== 'negotiation') {
      return res.status(400).json({ message: 'Cette conversation n\'est pas une négociation' });
    }

    const product = conversation.productId as any;

    if (!product) {
      return res.status(400).json({ message: 'Produit non trouvé dans cette négociation' });
    }

    // Vérifier que l'utilisateur est bien le vendeur
    if (product.seller.toString() !== userId) {
      return res.status(403).json({ message: 'Seul le vendeur peut répondre à cette offre' });
    }

    // Trouver la négociation dans le produit
    const productDoc = await Product.findById(product._id);
    const negotiationIndex = productDoc.negotiations.findIndex(
      (n: { conversationId: { toString(): string } }) => n.conversationId.toString() === conversationId
    );

    if (negotiationIndex === -1) {
      return res.status(404).json({ message: 'Négociation non trouvée pour ce produit' });
    }

    const negotiation = productDoc.negotiations[negotiationIndex];

    // Traiter l'action selon son type
    let statusMessage = '';
    let contentType = 'system_notification';

    switch (action) {
      case 'accept':
        // Accepter l'offre
        negotiation.status = 'accepted';
        statusMessage = `Offre de ${negotiation.currentOffer} ${product.currency} acceptée`;

        // Mettre à jour la conversation
        conversation.negotiation.status = 'accepted';
        await conversation.save();
        break;

      case 'reject':
        // Rejeter l'offre
        negotiation.status = 'rejected';
        statusMessage = `Offre de ${negotiation.currentOffer} ${product.currency} rejetée`;

        // Mettre à jour la conversation
        conversation.negotiation.status = 'rejected';
        await conversation.save();
        break;

      case 'counter':
        // Faire une contre-offre
        negotiation.counterOffer = counterOffer;
        negotiation.updatedAt = new Date();
        statusMessage = `Contre-offre de ${counterOffer} ${product.currency}`;
        contentType = 'counter_offer';

        // Mettre à jour la conversation
        conversation.negotiation.counterOffer = counterOffer;
        await conversation.save();
        break;
    }

    // Sauvegarder les changements dans le produit
    productDoc.negotiations[negotiationIndex] = negotiation;
    await productDoc.save();

    // Créer un message système pour l'action
    const systemMessage = await Message.create({
      conversation: conversationId,
      sender: userId,
      content: statusMessage,
      contentType,
      isSystemMessage: true,
      readBy: [userId]
    });

    // Créer un message avec le texte du vendeur si fourni
    let lastMessageId = systemMessage._id;

    if (message && message.trim()) {
      const userMessage = await Message.create({
        conversation: conversationId,
        sender: userId,
        content: message,
        contentType: 'text',
        readBy: [userId]
      });

      lastMessageId = userMessage._id;
    }

    // Mettre à jour la conversation avec le dernier message
    await Conversation.findByIdAndUpdate(
      conversationId,
      { lastMessage: lastMessageId, lastMessageAt: new Date() }
    );

    // Récupérer la conversation mise à jour
    const updatedConversation = await Conversation.findById(conversationId)
      .populate('participants', 'username profilePicture email')
      .populate('productId', 'title price images')
      .populate('lastMessage');

    return res.status(200).json({
      message: 'Réponse à la négociation envoyée avec succès',
      action,
      conversation: updatedConversation,
      negotiation: productDoc.negotiations[negotiationIndex]
    });
  } catch (error) {
    logger.error('Erreur lors de la réponse à une négociation', {
      error: error instanceof Error ? error.message : 'Erreur inconnue',
      stack: error instanceof Error ? error.stack : undefined,
      conversationId,
      userId,
      action
    });

    return res.status(500).json({
      message: 'Une erreur est survenue lors de la réponse à la négociation'
    });
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

/**
 * Récupère tous les médias d'une conversation - SIMPLIFIÉ
 */
export const getConversationMedia = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const conversationId = req.params.id;
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;
  const type = req.query.type as string;

  try {
    // Vérifier l'accès avec le service utilitaire
    await MessagingUtilsService.verifyConversationAccess(conversationId, userId);

    // Récupérer les messages avec médias
    const mediaMessages = await Message.find({
      conversation: conversationId,
      attachments: { $exists: true, $ne: [] },
      isDeleted: false
    })
      .select('attachments createdAt sender')
      .populate('sender', 'username profilePicture')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    // Utiliser le service utilitaire pour formater
    let media = MessagingUtilsService.formatConversationMedia(mediaMessages);

    // Filtrer par type si spécifié
    if (type && type !== 'all') {
      media = media.filter(item => item.type === type);
    }

    return res.status(200).json({
      media,
      pagination: {
        total: media.length,
        page,
        limit,
        pages: Math.ceil(media.length / limit)
      }
    });
  } catch (error) {
    logger.error('Erreur lors de la récupération des médias', { error, conversationId });
    return res.status(500).json({
      message: error instanceof Error ? error.message : 'Une erreur est survenue'
    });
  }
});

/**
 * Supprime une conversation pour l'utilisateur actuel
 * (soft delete - la conversation reste pour les autres participants)
 */
export const deleteConversation = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const conversationId = req.params.id;

  try {
    // Vérifier l'accès
    await MessagingUtilsService.verifyConversationAccess(conversationId, userId);

    // Ajouter l'utilisateur à la liste deletedBy
    const conversation = await Conversation.findByIdAndUpdate(
      conversationId,
      { $addToSet: { deletedBy: userId } },
      { new: true }
    );

    if (!conversation) {
      return res.status(404).json({ message: 'Conversation non trouvée' });
    }

    // Si tous les participants ont supprimé la conversation, la marquer comme inactive
    if (conversation.deletedBy.length === conversation.participants.length) {
      await Conversation.findByIdAndUpdate(
        conversationId,
        { isActive: false, status: 'closed' }
      );
    }

    logger.info(`Conversation ${conversationId} supprimée par l'utilisateur ${userId}`);

    return res.status(200).json({
      message: 'Conversation supprimée avec succès',
      conversationId
    });
  } catch (error) {
    logger.error('Erreur lors de la suppression de la conversation', { error, conversationId, userId });
    return res.status(500).json({
      message: error instanceof Error ? error.message : 'Une erreur est survenue'
    });
  }
});

/**
 * Archive une conversation
 */
export const archiveConversation = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const conversationId = req.params.id;

  try {
    // Vérifier l'accès
    await MessagingUtilsService.verifyConversationAccess(conversationId, userId);

    // Ajouter l'utilisateur à la liste archivedBy
    const conversation = await Conversation.findByIdAndUpdate(
      conversationId,
      { $addToSet: { archivedBy: userId } },
      { new: true }
    );

    if (!conversation) {
      return res.status(404).json({ message: 'Conversation non trouvée' });
    }

    logger.info(`Conversation ${conversationId} archivée par l'utilisateur ${userId}`);

    return res.status(200).json({
      message: 'Conversation archivée avec succès',
      conversationId,
      isArchived: true
    });
  } catch (error) {
    logger.error('Erreur lors de l\'archivage de la conversation', { error, conversationId, userId });
    return res.status(500).json({
      message: error instanceof Error ? error.message : 'Une erreur est survenue'
    });
  }
});

/**
 * Désarchive une conversation
 */
export const unarchiveConversation = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const conversationId = req.params.id;

  try {
    // Vérifier l'accès
    await MessagingUtilsService.verifyConversationAccess(conversationId, userId);

    // Retirer l'utilisateur de la liste archivedBy
    const conversation = await Conversation.findByIdAndUpdate(
      conversationId,
      { $pull: { archivedBy: userId } },
      { new: true }
    );

    if (!conversation) {
      return res.status(404).json({ message: 'Conversation non trouvée' });
    }

    logger.info(`Conversation ${conversationId} désarchivée par l'utilisateur ${userId}`);

    return res.status(200).json({
      message: 'Conversation désarchivée avec succès',
      conversationId,
      isArchived: false
    });
  } catch (error) {
    logger.error('Erreur lors du désarchivage de la conversation', { error, conversationId, userId });
    return res.status(500).json({
      message: error instanceof Error ? error.message : 'Une erreur est survenue'
    });
  }
});

/**
 * Toggle favoris d'une conversation
 */
export const toggleFavoriteConversation = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const conversationId = req.params.id;

  try {
    // Vérifier l'accès
    await MessagingUtilsService.verifyConversationAccess(conversationId, userId);

    // Vérifier si déjà en favoris
    const conversation = await Conversation.findById(conversationId);

    if (!conversation) {
      return res.status(404).json({ message: 'Conversation non trouvée' });
    }

    const isFavorited = conversation.favoritedBy.some(
      (id: mongoose.Types.ObjectId) => id.toString() === userId
    );

    let updatedConversation;
    if (isFavorited) {
      // Retirer des favoris
      updatedConversation = await Conversation.findByIdAndUpdate(
        conversationId,
        { $pull: { favoritedBy: userId } },
        { new: true }
      );
    } else {
      // Ajouter aux favoris
      updatedConversation = await Conversation.findByIdAndUpdate(
        conversationId,
        { $addToSet: { favoritedBy: userId } },
        { new: true }
      );
    }

    logger.info(`Conversation ${conversationId} ${isFavorited ? 'retirée des' : 'ajoutée aux'} favoris par l'utilisateur ${userId}`);

    return res.status(200).json({
      message: `Conversation ${isFavorited ? 'retirée des' : 'ajoutée aux'} favoris avec succès`,
      conversationId,
      isFavorited: !isFavorited
    });
  } catch (error) {
    logger.error('Erreur lors du toggle favoris de la conversation', { error, conversationId, userId });
    return res.status(500).json({
      message: error instanceof Error ? error.message : 'Une erreur est survenue'
    });
  }
});

/**
 * Récupère l'historique des offres d'une conversation
 */
export const getConversationOffers = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const conversationId = req.params.id;

  try {
    await MessagingUtilsService.verifyConversationAccess(conversationId, userId);

    const conversationRaw = await Conversation.findById(conversationId)
      .populate('offerHistory.offeredBy', 'username profilePicture')
      .populate({
        path: 'productId',
        select: 'title price images currency seller'
      })
      .lean();

    if (!conversationRaw) {
      return res.status(404).json({ message: 'Conversation non trouvée' });
    }

    // ✅ Typage propre
    const conversation = conversationRaw as LeanConversation;

    const response: any = {
      conversationId,
      type: conversation.type,
      offerHistory: conversation.offerHistory
    };

    if (conversation.type === 'negotiation' && conversation.negotiation) {
      response.currentNegotiation = {
        initialPrice: conversation.negotiation.initialPrice,
        currentOffer: conversation.negotiation.currentOffer,
        counterOffer: conversation.negotiation.counterOffer,
        status: conversation.negotiation.status,
        expiresAt: conversation.negotiation.expiresAt
      };
    }

    if (conversation.type === 'pay_what_you_want' && conversation.payWhatYouWant) {
      response.payWhatYouWant = {
        minimumPrice: conversation.payWhatYouWant.minimumPrice,
        maximumPrice: conversation.payWhatYouWant.maximumPrice,
        proposedPrice: conversation.payWhatYouWant.proposedPrice,
        status: conversation.payWhatYouWant.status
      };
    }

    if (conversation.productId) {
      response.product = conversation.productId;
      response.isOwner = conversation.productId.seller.toString() === userId;
    }

    return res.status(200).json(response);
  } catch (error) {
    logger.error('Erreur lors de la récupération des offres', { error, conversationId, userId });
    return res.status(500).json({
      message: error instanceof Error ? error.message : 'Une erreur est survenue'
    });
  }
});