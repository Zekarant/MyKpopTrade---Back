import { Request, Response } from 'express';
import logger from '../../../commons/utils/logger';
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
  fetchConversationOffers,
  cancelOfferFlow
} from '../services/conversationOfferService';
import { respondToNegotiationFlow } from '../services/negotiationResponseService';
import {
  initiatePayWhatYouWantFlow,
  makePayWhatYouWantProposalFlow
} from '../services/payWhatYouWantService';
import { parsePagination } from '../../../commons/utils/pagination';
import { queryString } from '../../../commons/utils/query';

const DEFAULT_CONVERSATION_LIMIT = 20;
const DEFAULT_USER_LIST_LIMIT = 10;

/**
 * Récupère une conversation spécifique avec ses messages
 */
export const getConversation = async (req: Request, res: Response) => {
  const { page, limit } = parsePagination(req.query, { defaultLimit: DEFAULT_CONVERSATION_LIMIT });
  const result = await fetchConversation(req.params.id as string, req.user!.id, page, limit);
  res.status(200).json(result);
};

/**
 * Récupère la liste des conversations d'un utilisateur
 */
export const getUserConversations = async (req: Request, res: Response) => {
  const { page, limit } = parsePagination(req.query, { defaultLimit: DEFAULT_USER_LIST_LIMIT });
  const filter = queryString(req.query.filter) || 'all';

  const result = await listUserConversations(req.user!.id, page, limit, filter);
  res.status(200).json(result);
};

/**
 * Crée une nouvelle conversation
 */
export const startConversation = async (req: Request, res: Response) => {
  const { recipientId, productId, initialMessage, type = 'general' } = req.body ?? {};

  const conversation = await createConversationForUser({
    userId: req.user!.id,
    recipientId,
    productId,
    initialMessage,
    type
  });

  res.status(201).json({
    message: 'Conversation créée avec succès',
    conversation
  });
};

/**
 * Initie une négociation pour un produit
 */
export const initiateNegotiation = async (req: Request, res: Response) => {
  const { productId, initialOffer, message } = req.body ?? {};

  const result = await initiateNegotiationFlow({
    userId: req.user!.id,
    productId,
    initialOffer,
    message
  });

  res.status(result.isUpdate ? 200 : 201).json({
    message: result.isUpdate ? 'Offre mise à jour avec succès' : 'Négociation initiée avec succès',
    conversation: result.conversation,
    initialOffer: result.initialOffer,
    isUpdate: result.isUpdate,
    previousOffer: result.previousOffer
  });
};

/**
 * Répond à une négociation (accept, reject, counter)
 */
export const respondToNegotiation = async (req: Request, res: Response) => {
  const { action, counterOffer, message } = req.body ?? {};

  const result = await respondToNegotiationFlow({
    userId: req.user!.id,
    conversationId: req.params.id as string,
    action,
    counterOffer,
    message
  });

  res.status(200).json({
    message: 'Réponse à la négociation envoyée avec succès',
    action: result.action,
    conversation: result.conversation,
    negotiation: result.negotiation
  });
};

/**
 * Initie une offre Pay What You Want sur un produit
 */
export const initiatePayWhatYouWant = async (req: Request, res: Response) => {
  const { productId, minimumPrice, maximumPrice, enabled } = req.body ?? {};

  const payWhatYouWant = await initiatePayWhatYouWantFlow({
    userId: req.user!.id,
    productId,
    minimumPrice,
    maximumPrice,
    enabled
  });

  if (!payWhatYouWant.enabled) {
    res.status(200).json({
      message: 'Option Pay What You Want désactivée avec succès',
      payWhatYouWant
    });
    return;
  }

  res.status(201).json({
    message: 'Option Pay What You Want activée avec succès',
    payWhatYouWant
  });
};

/**
 * Fait une proposition dans une conversation Pay What You Want
 */
export const makePayWhatYouWantProposal = async (req: Request, res: Response) => {
  const { proposedPrice, message } = req.body ?? {};

  const result = await makePayWhatYouWantProposalFlow({
    userId: req.user!.id,
    conversationId: req.params.id as string,
    proposedPrice,
    message
  });

  res.status(200).json({
    message: 'Proposition de prix envoyée avec succès',
    result
  });
};

/**
 * Récupère tous les médias d'une conversation
 */
export const getConversationMedia = async (req: Request, res: Response) => {
  const { page, limit } = parsePagination(req.query, { defaultLimit: DEFAULT_CONVERSATION_LIMIT });

  const result = await fetchConversationMedia({
    userId: req.user!.id,
    conversationId: req.params.id as string,
    page,
    limit,
    type: queryString(req.query.type)
  });
  res.status(200).json(result);
};

/**
 * Supprime une conversation pour l'utilisateur actuel
 */
export const deleteConversation = async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const conversationId = req.params.id as string;

  await softDeleteConversation(userId, conversationId);
  logger.info(`Conversation ${conversationId} supprimée par l'utilisateur ${userId}`);

  res.status(200).json({
    message: 'Conversation supprimée avec succès',
    conversationId
  });
};

/**
 * Archive une conversation
 */
export const archiveConversation = async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const conversationId = req.params.id as string;

  await archiveConversationForUser(userId, conversationId);
  logger.info(`Conversation ${conversationId} archivée par l'utilisateur ${userId}`);

  res.status(200).json({
    message: 'Conversation archivée avec succès',
    conversationId,
    isArchived: true
  });
};

/**
 * Désarchive une conversation
 */
export const unarchiveConversation = async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const conversationId = req.params.id as string;

  await unarchiveConversationForUser(userId, conversationId);
  logger.info(`Conversation ${conversationId} désarchivée par l'utilisateur ${userId}`);

  res.status(200).json({
    message: 'Conversation désarchivée avec succès',
    conversationId,
    isArchived: false
  });
};

/**
 * Toggle favoris d'une conversation
 */
export const toggleFavoriteConversation = async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const conversationId = req.params.id as string;

  const { wasFavorited } = await toggleFavoriteConversationForUser(userId, conversationId);
  const change = wasFavorited ? 'retirée des' : 'ajoutée aux';
  logger.info(`Conversation ${conversationId} ${change} favoris par l'utilisateur ${userId}`);

  res.status(200).json({
    message: `Conversation ${change} favoris avec succès`,
    conversationId,
    isFavorited: !wasFavorited
  });
};

/**
 * Récupère l'historique des offres d'une conversation
 */
export const getConversationOffers = async (req: Request, res: Response) => {
  const response = await fetchConversationOffers(req.user!.id, req.params.id as string);
  res.status(200).json(response);
};

/**
 * Annule une offre en cours
 */
export const cancelOffer = async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const conversationId = req.params.id as string;

  const cancelledOffer = await cancelOfferFlow(userId, conversationId);
  logger.info(`Offre annulée pour la conversation ${conversationId} par l'utilisateur ${userId}`);

  res.status(200).json({
    message: 'Offre annulée avec succès',
    conversationId,
    cancelledOffer
  });
};
