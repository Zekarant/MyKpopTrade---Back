import Notification from '../../../models/notificationModel';
import User from '../../../models/userModel';
import mongoose from 'mongoose';
import logger from '../../../commons/utils/logger';

/**
 * Service pour la gestion des notifications
 */
export class NotificationService {
  /**
   * Crée une nouvelle notification
   */
  static async createNotification({
    recipientId,
    type,
    title,
    content,
    link = null,
    data = {},
    expiresInDays = 30
  }: {
    recipientId: string | mongoose.Types.ObjectId;
    type: string;
    title: string;
    content: string;
    link?: string | null;
    data?: any;
    expiresInDays?: number;
  }) {
    try {
      // Vérifier si le destinataire existe
      const recipient = await User.findById(recipientId);
      if (!recipient) {
        throw new Error(`Destinataire introuvable: ${recipientId}`);
      }
      
      // Calculer la date d'expiration
      const expiresAt = expiresInDays 
        ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000) 
        : undefined;
      
      // Créer la notification
      const notification = await Notification.create({
        recipient: recipientId,
        type,
        title,
        content,
        link,
        data,
        isRead: false,
        expiresAt
      });
      
      logger.info(`Notification créée pour l'utilisateur ${recipientId}`, {
        notificationId: notification._id,
        type
      });
    
      
      return notification;
    } catch (error) {
      logger.error('Erreur lors de la création de notification', { 
        error: error instanceof Error ? error.message : 'Erreur inconnue',
        recipientId, 
        type 
      });
      throw error;
    }
  }
  
  /**
   * Récupère les notifications d'un utilisateur avec pagination
   */
  static async getUserNotifications(userId: string | mongoose.Types.ObjectId, {
    page = 1,
    limit = 20,
    onlyUnread = false
  } = {}) {
    try {
      const query: any = { recipient: userId };
      
      if (onlyUnread) {
        query.isRead = false;
      }
      
      // Compter le total de notifications non lues
      const unreadCount = await Notification.countDocuments({ 
        recipient: userId, 
        isRead: false 
      });
      
      // Récupérer les notifications avec pagination
      const notifications = await Notification.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit);
      
      // Compter le total pour la pagination
      const total = await Notification.countDocuments(query);
      
      return {
        notifications,
        pagination: {
          total,
          unreadCount,
          page,
          limit,
          pages: Math.ceil(total / limit)
        }
      };
    } catch (error) {
      logger.error('Erreur lors de la récupération des notifications', { 
        error: error instanceof Error ? error.message : 'Erreur inconnue',
        userId 
      });
      throw error;
    }
  }
  
  /**
   * Marque une notification comme lue
   */
  static async markAsRead(notificationId: string, userId: string) {
    try {
      const notification = await Notification.findOneAndUpdate(
        { _id: notificationId, recipient: userId },
        { isRead: true },
        { new: true }
      );
      
      if (!notification) {
        throw new Error('Notification non trouvée ou non autorisée');
      }
      
      return notification;
    } catch (error) {
      logger.error('Erreur lors du marquage de notification comme lue', { 
        error: error instanceof Error ? error.message : 'Erreur inconnue',
        notificationId,
        userId 
      });
      throw error;
    }
  }
  
  /**
   * Marque toutes les notifications d'un utilisateur comme lues
   */
  static async markAllAsRead(userId: string) {
    try {
      const result = await Notification.updateMany(
        { recipient: userId, isRead: false },
        { isRead: true }
      );
      
      return result.modifiedCount;
    } catch (error) {
      logger.error('Erreur lors du marquage de toutes les notifications comme lues', { 
        error: error instanceof Error ? error.message : 'Erreur inconnue',
        userId 
      });
      throw error;
    }
  }
  
  /**
   * Supprime une notification
   */
  static async deleteNotification(notificationId: string, userId: string) {
    try {
      const notification = await Notification.findOneAndDelete({
        _id: notificationId,
        recipient: userId
      });
      
      if (!notification) {
        throw new Error('Notification non trouvée ou non autorisée');
      }
      
      return notification;
    } catch (error) {
      logger.error('Erreur lors de la suppression de notification', { 
        error: error instanceof Error ? error.message : 'Erreur inconnue',
        notificationId,
        userId 
      });
      throw error;
    }
  }
}