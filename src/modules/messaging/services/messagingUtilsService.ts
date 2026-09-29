import mongoose from 'mongoose';
import path from 'path';
import Message from '../../../models/messageModel';
import Conversation from '../../../models/conversationModel';
import logger from '../../../commons/utils/logger';

type MediaMessage = {
  _id: mongoose.Types.ObjectId;
  attachments?: string[];
  createdAt: Date;
  sender: unknown;
};

type MessagePreviewSource = {
  content: string;
  contentType?: string;
  isEncrypted?: boolean;
};

export class MessagingUtilsService {
  /**
   * Vérifie l'accès d'un utilisateur à une conversation
   */
  static async verifyConversationAccess(conversationId: string, userId: string) {
    const conversation = await Conversation.findOne({
      _id: conversationId,
      participants: userId,
      isActive: true
    });
    
    if (!conversation) {
      throw new Error('Conversation non trouvée ou accès refusé');
    }
    
    return conversation;
  }

  /**
   * Marque tous les messages non lus d'une conversation comme lus
   */
  static async markConversationAsRead(conversationId: string, userId: string) {
    try {
      const result = await Message.updateMany(
        { 
          conversation: new mongoose.Types.ObjectId(conversationId),
          sender: { $ne: new mongoose.Types.ObjectId(userId) },
          readBy: { $ne: new mongoose.Types.ObjectId(userId) },
          isDeleted: false
        },
        { $addToSet: { readBy: new mongoose.Types.ObjectId(userId) } }
      );
      
      logger.info(`${result.modifiedCount} messages marqués comme lus pour l'utilisateur ${userId}`);
      return result.modifiedCount;
    } catch (error) {
      logger.error('Erreur lors du marquage des messages comme lus', { error, conversationId, userId });
      return 0;
    }
  }

  /**
   * Formate les médias d'une conversation
   */
  static formatConversationMedia(mediaMessages: MediaMessage[]) {
    return mediaMessages.flatMap(msg =>
      (msg.attachments ?? []).map(attachment => {
        const extension = path.extname(attachment).toLowerCase();
        const isImage = ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(extension);
        const isPDF = extension === '.pdf';
        
        return {
          filename: attachment,
          originalName: attachment,
          url: `/api/messaging/messages/${msg._id}/attachments/${attachment}`,
          type: isImage ? 'image' : isPDF ? 'document' : 'other',
          extension,
          uploadedAt: msg.createdAt,
          uploadedBy: msg.sender,
          messageId: msg._id.toString(),
          size: null
        };
      })
    );
  }

  /**
   * Calcule le nombre de messages non lus pour une conversation
   */
  static async getUnreadCount(conversationId: string, userId: string) {
    try {
      return await Message.countDocuments({
        conversation: new mongoose.Types.ObjectId(conversationId),
        sender: { $ne: new mongoose.Types.ObjectId(userId) },
        readBy: { $ne: new mongoose.Types.ObjectId(userId) },
        isDeleted: false
      });
    } catch (error) {
      logger.error('Erreur lors du calcul des messages non lus', { error, conversationId, userId });
      return 0;
    }
  }

  /**
   * Met à jour la conversation avec le dernier message
   */
  static async updateConversationLastMessage(conversationId: string, messageId: string) {
    await Conversation.findByIdAndUpdate(conversationId, {
      lastMessage: messageId,
      lastMessageAt: new Date(),
      status: 'open'
    });
  }

  /**
   * Valide les types de fichiers autorisés
   */
  static validateFileType(mimetype: string): boolean {
    const allowedTypes = [
      'image/jpeg', 
      'image/png', 
      'image/gif', 
      'image/webp',
      'application/pdf',
      'text/plain'
    ];
    return allowedTypes.includes(mimetype);
  }

  /**
   * Génère un aperçu de message selon son type
   */
  static generateMessagePreview(message: MessagePreviewSource | null | undefined): string {
    if (!message) return '';
    
    if (message.isEncrypted) {
      return '[Message chiffré]';
    }
    
    switch (message.contentType) {
      case 'system_notification':
        return message.content;
      case 'offer':
        return '💰 Nouvelle offre';
      case 'counter_offer':
        return '🔄 Contre-offre';
      case 'shipping_update':
        return '📦 Mise à jour expédition';
      default:
        return message.content.length > 50 
          ? message.content.substring(0, 50) + '...'
          : message.content;
    }
  }

  /**
   * Valide si un utilisateur peut créer une conversation
   */
  static async validateConversationCreation(userId: string, recipientId: string) {
    if (userId === recipientId) {
      throw new Error('Vous ne pouvez pas créer une conversation avec vous-même');
    }
    
    // Vérifier que les utilisateurs existent
    const User = (await import('../../../models/userModel')).default;
    
    const users = await User.find({
      _id: { $in: [userId, recipientId] },
      isActive: true
    });
    
    if (users.length !== 2) {
      throw new Error('Un ou plusieurs utilisateurs sont introuvables ou inactifs');
    }
    
    return users;
  }

  /**
   * Formate les catégories de produits
   */
  static formatCategory(category: string): string {
    const categoryMap: { [key: string]: string } = {
      'album': 'Album',
      'photocard': 'Photocard',
      'poster': 'Poster',
      'lightstick': 'Lightstick',
      'clothing': 'Vêtements',
      'accessories': 'Accessoires',
      'limited_edition': 'Édition Limitée',
      'other': 'Autre'
    };
    
    return categoryMap[category] || category;
  }
}