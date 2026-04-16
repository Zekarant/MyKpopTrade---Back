import { Request, Response } from 'express';
import { asyncHandler } from '../../../commons/middlewares/errorMiddleware';
import logger from '../../../commons/utils/logger';
import { HttpError } from '../../../commons/utils/httpError';
import {
  fetchConversation,
  listUserConversations,
  createConversationForUser,
  fetchConversationMedia,
  softDeleteConversation,
  archiveConversationForUser,
  unarchiveConversationForUser,
  toggleFavoriteConversationForUser
} from '../services/conversationService';
import {
  initiateNegotiationFlow,
  respondToNegotiationFlow,
  initiatePayWhatYouWantFlow,
  makePayWhatYouWantProposalFlow,
  fetchConversationOffers,
  cancelOfferFlow
} from '../services/conversationOfferService';

/**
 * Récupère une conversation spécifique avec ses messages
 */
export const getConversation = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const conversationId = req.params.id as string;
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;

  try {
    const result = await fetchConversation(conversationId, userId, page, limit);
    return res.status(200).json(result);
  } catch (error) {
    if (error instanceof HttpError) {
      return res.status(error.statusCode).json({ message: error.message });
    }
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

  const result = await listUserConversations(userId, page, limit, filter);
  return res.status(200).json(result);
});

/**
 * Crée une nouvelle conversation
 */
export const startConversation = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const { recipientId, productId, initialMessage, type = 'general' } = req.body;

  try {
    const conversation = await createConversationForUser({
      userId,
      recipientId,
      productId,
      initialMessage,
      type
    });

    return res.status(201).json({
      message: 'Conversation créée avec succès',
      conversation
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return res.status(error.statusCode).json({ message: error.message });
    }

    if (error instanceof Error) {
      logger.error('Erreur lors de la création de la conversation', {
        error: error.message,
        stack: error.stack,
        path: (error as any).path
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

  try {
    const result = await initiateNegotiationFlow({
      userId,
      productId,
      initialOffer,
      message
    });

    return res.status(result.isUpdate ? 200 : 201).json({
      message: result.isUpdate ? 'Offre mise à jour avec succès' : 'Négociation initiée avec succès',
      conversation: result.conversation,
      initialOffer: result.initialOffer,
      isUpdate: result.isUpdate,
      previousOffer: result.previousOffer
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return res.status(error.statusCode).json({ message: error.message });
    }
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
  const conversationId = req.params.id as string;
  const { action, counterOffer, message } = req.body;

  try {
    const result = await respondToNegotiationFlow({
      userId,
      conversationId,
      action,
      counterOffer,
      message
    });

    return res.status(200).json({
      message: 'Réponse à la négociation envoyée avec succès',
      action: result.action,
      conversation: result.conversation,
      negotiation: result.negotiation
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return res.status(error.statusCode).json({ message: error.message });
    }
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

  try {
    const payWhatYouWant = await initiatePayWhatYouWantFlow({
      userId,
      productId,
      minimumPrice,
      maximumPrice,
      message
    });

    return res.status(201).json({
      message: 'Option Pay What You Want activée avec succès',
      payWhatYouWant
    });
  } catch (error: any) {
    if (error instanceof HttpError) {
      return res.status(error.statusCode).json({ message: error.message });
    }
    logger.error('Erreur lors de l\'activation de Pay What You Want', { error });
    return res.status(400).json({ message: error.message });
  }
});

/**
 * Fait une proposition dans une conversation Pay What You Want
 */
export const makePayWhatYouWantProposal = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const conversationId = req.params.id as string;
  const { proposedPrice, message } = req.body;

  try {
    const result = await makePayWhatYouWantProposalFlow({
      userId,
      conversationId,
      proposedPrice,
      message
    });

    return res.status(200).json({
      message: 'Proposition de prix envoyée avec succès',
      result
    });
  } catch (error: any) {
    if (error instanceof HttpError) {
      return res.status(error.statusCode).json({ message: error.message });
    }
    logger.error('Erreur lors de la proposition d\'un prix PWYW', { error });
    return res.status(400).json({ message: error.message });
  }
});

/**
 * Récupère tous les médias d'une conversation
 */
export const getConversationMedia = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const conversationId = req.params.id as string;
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;
  const type = req.query.type as string;

  try {
    const result = await fetchConversationMedia({ userId, conversationId, page, limit, type });
    return res.status(200).json(result);
  } catch (error) {
    if (error instanceof HttpError) {
      return res.status(error.statusCode).json({ message: error.message });
    }
    logger.error('Erreur lors de la récupération des médias', { error, conversationId });
    return res.status(500).json({
      message: error instanceof Error ? error.message : 'Une erreur est survenue'
    });
  }
});

/**
 * Supprime une conversation pour l'utilisateur actuel
 */
export const deleteConversation = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const conversationId = req.params.id as string;

  try {
    await softDeleteConversation(userId, conversationId);
    logger.info(`Conversation ${conversationId} supprimée par l'utilisateur ${userId}`);
    return res.status(200).json({
      message: 'Conversation supprimée avec succès',
      conversationId
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return res.status(error.statusCode).json({ message: error.message });
    }
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
  const conversationId = req.params.id as string;

  try {
    await archiveConversationForUser(userId, conversationId);
    logger.info(`Conversation ${conversationId} archivée par l'utilisateur ${userId}`);
    return res.status(200).json({
      message: 'Conversation archivée avec succès',
      conversationId,
      isArchived: true
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return res.status(error.statusCode).json({ message: error.message });
    }
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
  const conversationId = req.params.id as string;

  try {
    await unarchiveConversationForUser(userId, conversationId);
    logger.info(`Conversation ${conversationId} désarchivée par l'utilisateur ${userId}`);
    return res.status(200).json({
      message: 'Conversation désarchivée avec succès',
      conversationId,
      isArchived: false
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return res.status(error.statusCode).json({ message: error.message });
    }
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
  const conversationId = req.params.id as string;

  try {
    const { wasFavorited } = await toggleFavoriteConversationForUser(userId, conversationId);
    const isFavorited = !wasFavorited;

    logger.info(
      `Conversation ${conversationId} ${wasFavorited ? 'retirée des' : 'ajoutée aux'} favoris par l'utilisateur ${userId}`
    );

    return res.status(200).json({
      message: `Conversation ${wasFavorited ? 'retirée des' : 'ajoutée aux'} favoris avec succès`,
      conversationId,
      isFavorited
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return res.status(error.statusCode).json({ message: error.message });
    }
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
  const conversationId = req.params.id as string;

  try {
    const response = await fetchConversationOffers(userId, conversationId);
    return res.status(200).json(response);
  } catch (error) {
    if (error instanceof HttpError) {
      return res.status(error.statusCode).json({ message: error.message });
    }
    logger.error('Erreur lors de la récupération des offres', { error, conversationId, userId });
    return res.status(500).json({
      message: error instanceof Error ? error.message : 'Une erreur est survenue'
    });
  }
});

/**
 * Annule une offre en cours
 */
export const cancelOffer = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const conversationId = req.params.id as string;

  try {
    const cancelledOffer = await cancelOfferFlow(userId, conversationId);
    logger.info(`Offre annulée pour la conversation ${conversationId} par l'utilisateur ${userId}`);
    return res.status(200).json({
      message: 'Offre annulée avec succès',
      conversationId,
      cancelledOffer
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return res.status(error.statusCode).json({ message: error.message });
    }
    logger.error('Erreur lors de l\'annulation de l\'offre', { error, conversationId, userId });
    return res.status(500).json({
      message: error instanceof Error ? error.message : 'Une erreur est survenue'
    });
  }
});
