import { Request, Response, NextFunction } from 'express';
import { RateLimiterMongo } from 'rate-limiter-flexible';
import mongoose from 'mongoose';
import User from '../../../models/userModel';
import Message from '../../../models/messageModel';
import Conversation from '../../../models/conversationModel';
import logger from '../../../commons/utils/logger';

// Limite de messages par utilisateur par intervalle de temps
const messageLimiter = new RateLimiterMongo({
  storeClient: mongoose.connection,
  keyPrefix: 'messaging_rate_limit',
  points: 10, // nombre de messages autorisés
  duration: 60, // par minute
});

/**
 * Middleware pour limiter le nombre de messages (anti-spam)
 */
export const rateLimitMessages = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = (req.user as any).id;
    await messageLimiter.consume(userId);
    next();
  } catch (error) {
    logger.warn(`Limite de messages dépassée par l'utilisateur ${(req.user as any).id}`);
    res.status(429).json({ 
      message: 'Vous envoyez trop de messages. Veuillez attendre avant d\'en envoyer d\'autres.' 
    });
  }
};

/**
 * Vérifier si l'utilisateur a le droit de participer à une conversation
 */
export const verifyConversationAccess = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const userId = (req.user as any).id;
  const conversationId = req.params.id || req.body.conversationId;
  
  if (!conversationId) {
    return next();
  }

  try {
    const conversation = await Conversation.findById(conversationId);
    
    if (!conversation) {
      res.status(404).json({ message: 'Conversation non trouvée' });
      return;
    }
    
    // Vérifier que l'utilisateur est bien un participant de la conversation
    // Define the participant type for more clarity
    interface ConversationParticipant {
      _id: mongoose.Types.ObjectId;
      toString(): string;
    }
    
    // Type assertion for conversation.participants
    const participants: ConversationParticipant[] = conversation.participants as ConversationParticipant[];
    
    if (!participants.some((p: ConversationParticipant) => p.toString() === userId)) {
      logger.warn(`Tentative d'accès non autorisé à la conversation ${conversationId} par l'utilisateur ${userId}`);
      res.status(403).json({ message: 'Vous n\'êtes pas autorisé à accéder à cette conversation' });
      return;
    }
    
    next();
  } catch (error) {
    logger.error(`Erreur lors de la vérification d'accès à la conversation`, { error });
    res.status(500).json({ message: 'Une erreur est survenue' });
  }
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