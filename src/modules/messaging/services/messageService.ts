import mongoose from 'mongoose';
import Message from '../../../models/messageModel';
import Conversation from '../../../models/conversationModel';
import User from '../../../models/userModel';
import { encryptMessage, decryptMessage } from './encryptionService';
import logger from '../../../commons/utils/logger';

/**
 * Crée une nouvelle conversation entre utilisateurs
 */
export const createConversation = async ({
  participants,
  productId = null,
  type = 'general',
  title = '',
  createdBy
}: {
  participants: string[];
  productId?: string | null;
  type?: 'general' | 'product_inquiry' | 'negotiation' | 'pay_what_you_want';
  title?: string;
  createdBy: string;
}): Promise<any> => {
  try {
    // Vérifier que tous les participants existent
    const users = await User.find({ _id: { $in: participants } });
    
    if (users.length !== participants.length) {
      throw new Error('Un ou plusieurs utilisateurs n\'existent pas');
    }
    
    // Vérifier si une conversation existe déjà pour les mêmes participants et produit
    let query: any = {
      participants: { $all: participants },
      isActive: true
    };
    
    if (productId) {
      query.productId = productId;
    }
    
    const existingConversation = await Conversation.findOne(query);
    
    if (existingConversation) {
      return existingConversation;
    }
    
    // Créer une nouvelle conversation
    const conversationData: any = {
      participants,
      createdBy,
      type,
      status: 'open',
      isActive: true,
      lastMessageAt: new Date()
    };
    
    if (productId) {
      conversationData.productId = productId;
    }
    
    if (title) {
      conversationData.title = title;
    }
    
    // Ajouter des options spécifiques selon le type de conversation
    if (type === 'negotiation' || type === 'pay_what_you_want') {
      // Ces détails seront ajoutés ultérieurement via des méthodes dédiées
    }
    
    const newConversation = await Conversation.create(conversationData);
    
    // Ajouter un message système
    const systemMessage = {
      conversation: newConversation._id,
      sender: createdBy,
      content: type === 'general' 
        ? 'Conversation créée'
        : 'Discussion à propos du produit démarrée',
      contentType: 'system_notification',
      readBy: [createdBy]
    };
    
    await Message.create(systemMessage);
    
    return newConversation;
  } catch (error) {
    logger.error('Erreur lors de la création d\'une conversation', { error });
    throw error;
  }
};

/**
 * Envoie un message dans une conversation
 */
export const sendMessage = async ({
  conversationId,
  senderId,
  content,
  attachments = [],
  contentType = 'text',
  metadata = {},
  encrypt = true
}: {
  conversationId: string;
  senderId: string;
  content: string;
  attachments?: string[];
  contentType?: 'text' | 'system_notification' | 'offer' | 'counter_offer' | 'shipping_update';
  metadata?: any;
  encrypt?: boolean;
}): Promise<any> => {
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    // Vérifier si l'expéditeur fait partie de la conversation
    const conversation = await Conversation.findOne({ 
      _id: conversationId,
      participants: senderId,
      status: 'open',
      isActive: true
    });
    
    if (!conversation) {
      throw new Error('Conversation non trouvée ou accès refusé');
    }
    
    let messageData: any = {
      conversation: conversationId,
      sender: senderId,
      contentType,
      readBy: [senderId]
    };
    
    // Chiffrer le contenu si nécessaire
    if (encrypt && contentType === 'text') {
      const { encryptedContent, algorithm, iv } = encryptMessage(content);
      
      messageData.content = encryptedContent;
      messageData.isEncrypted = true;
      messageData.encryptionDetails = {
        algorithm,
        iv
      };
    } else {
      messageData.content = content;
      messageData.isEncrypted = false;
    }
    
    if (attachments.length > 0) {
      messageData.attachments = attachments;
    }
    
    if (Object.keys(metadata).length > 0) {
      messageData.metadata = metadata;
    }
    
    // Créer le message
    const newMessage = await Message.create([messageData], { session });
    
    // Mettre à jour la date du dernier message dans la conversation
    await Conversation.updateOne(
      { _id: conversationId },
      { lastMessageAt: new Date() },
      { session }
    );
    
    await session.commitTransaction();
    
    return newMessage[0];
  } catch (error) {
    await session.abortTransaction();
    logger.error('Erreur lors de l\'envoi d\'un message', { error });
    throw error;
  } finally {
    session.endSession();
  }
};

/**
 * Récupère les messages d'une conversation avec pagination
 */
export const getConversationMessages = async ({
  conversationId,
  userId,
  page = 1,
  limit = 20,
  decryptMessages = true
}: {
  conversationId: string;
  userId: string;
  page?: number;
  limit?: number;
  decryptMessages?: boolean;
}): Promise<{
  messages: any[];
  pagination: {
    total: number;
    page: number;
    limit: number;
    pages: number;
  };
}> => {
  try {
    // Vérifier si l'utilisateur fait partie de la conversation
    const conversation = await Conversation.findOne({
      _id: conversationId,
      participants: userId
    });
    
    if (!conversation) {
      throw new Error('Conversation non trouvée ou accès refusé');
    }
    
    // Calculer le nombre total de messages
    const totalMessages = await Message.countDocuments({
      conversation: conversationId,
      isDeleted: false
    });
    
    // Récupérer les messages avec pagination
    const messages = await Message.find({
      conversation: conversationId,
      isDeleted: false
    })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('sender', 'username profilePicture')
      .lean();
    
    // Marquer les messages comme lus
    await Message.updateMany(
      {
        conversation: conversationId,
        readBy: { $ne: userId }
      },
      { $addToSet: { readBy: userId } }
    );
    
    // Déchiffrer les messages si nécessaire
    const processedMessages = messages.map(message => {
      if (decryptMessages && message.isEncrypted) {
        try {
          const decryptedContent = decryptMessage(
            message.content,
            message.encryptionDetails.algorithm,
            message.encryptionDetails.iv
          );
          
          return {
            ...message,
            content: decryptedContent,
            isEncrypted: false, // Indiquer que le contenu est maintenant déchiffré
            encryptionDetails: undefined // Ne pas exposer les détails de chiffrement
          };
        } catch (error) {
          logger.error('Erreur lors du déchiffrement d\'un message', { 
            messageId: message._id,
            error 
          });
          
          return {
            ...message,
            content: '[Message chiffré non lisible]'
          };
        }
      }
      
      return message;
    });
    
    return {
      messages: processedMessages.reverse(), // Renverser pour avoir les plus anciens en premier
      pagination: {
        total: totalMessages,
        page,
        limit,
        pages: Math.ceil(totalMessages / limit)
      }
    };
  } catch (error) {
    logger.error('Erreur lors de la récupération des messages', { error });
    throw error;
  }
};