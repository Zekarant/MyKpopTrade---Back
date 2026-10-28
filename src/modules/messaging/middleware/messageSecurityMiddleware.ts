import { Request, Response, NextFunction } from 'express';
import { RateLimiterMongo } from 'rate-limiter-flexible';
import mongoose from 'mongoose';
import Conversation from '../../../models/conversationModel';
import logger from '../../../commons/utils/logger';
import { isRateLimiterRes } from '../../../commons/utils/rateLimiterRes';
import { HttpError, notFound, forbidden } from '../../../commons/utils/httpError';

let messageLimiterInstance: RateLimiterMongo | null = null;

function getMessageLimiter(): RateLimiterMongo {
  if (!messageLimiterInstance) {
    messageLimiterInstance = new RateLimiterMongo({
      storeClient: mongoose.connection,
      keyPrefix: 'messaging_rate_limit',
      points: 10,
      duration: 60,
      tableName: 'rate_limits',
    });
  }
  return messageLimiterInstance;
}

/**
 * Middleware pour limiter le nombre de messages (anti-spam)
 */
export const rateLimitMessages = async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
  const userId = req.user!.id;
  try {
    await getMessageLimiter().consume(userId);
  } catch (error) {
    if (isRateLimiterRes(error)) {
      logger.warn(`Limite de messages dépassée par l'utilisateur ${userId}`);
      throw new HttpError(
        429,
        'Vous envoyez trop de messages. Veuillez attendre avant d\'en envoyer d\'autres.',
        'TOO_MANY_MESSAGES'
      );
    }
    // Panne technique du limiteur (base pas prête) : l'envoi n'est pas bloqué pour autant.
    logger.warn('Limiteur de messages indisponible, envoi laissé passer', {
      error: error instanceof Error ? error.message : String(error)
    });
  }
  next();
};

/**
 * Vérifie que l'utilisateur participe à la conversation `:id` (ou `conversationId` du corps).
 * Un identifiant mal formé répond 400 (CastError, cf. errorMiddleware).
 */
export const verifyConversationAccess = async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
  const userId = req.user!.id;
  const conversationId = req.params.id || req.body?.conversationId;

  if (!conversationId) {
    next();
    return;
  }

  const conversation = await Conversation.findById(conversationId).select('participants').lean();

  if (!conversation) {
    throw notFound('Conversation non trouvée', 'CONVERSATION_NOT_FOUND');
  }

  if (!conversation.participants.some((participant) => participant.toString() === userId)) {
    logger.warn(`Tentative d'accès non autorisé à la conversation ${conversationId} par l'utilisateur ${userId}`);
    throw forbidden('Vous n\'êtes pas autorisé à accéder à cette conversation', 'CONVERSATION_FORBIDDEN');
  }

  next();
};

/**
 * Vérifier si le contenu du message est approprié
 */
export const validateMessageContent = (req: Request, res: Response, next: NextFunction): void => {
  const { content } = req.body;
  
  // Vérifier que le contenu n'est pas vide
  if (!content || content.trim() === '') {
    res.status(400).json({ message: 'Le contenu du message ne peut pas être vide' });
    return;
  }
  
  // Vérifier la longueur du message
  if (content.length > 5000) {
    res.status(400).json({ message: 'Le message est trop long (maximum 5000 caractères)' });
    return;
  }
  
  // Filtrage basique de contenu inapproprié (à améliorer avec une API de modération)
  const inappropriateContent = ['spam', 'scam', 'phishing']; // Liste basique à étendre
  const containsInappropriate = inappropriateContent.some(word => 
    content.toLowerCase().includes(word)
  );
  
  if (containsInappropriate) {
    res.status(400).json({ message: 'Le contenu du message semble inapproprié' });
    return;
  }
  
  next();
};