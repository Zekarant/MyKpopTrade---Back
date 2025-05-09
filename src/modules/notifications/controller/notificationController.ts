import { Request, Response } from 'express';
import { asyncHandler } from '../../../commons/middlewares/errorMiddleware';
import { NotificationService } from '../services/notificationService';
import logger from '../../../commons/utils/logger';

/**
 * Récupère les notifications de l'utilisateur connecté
 */
export const getMyNotifications = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const { page = '1', limit = '20', unread } = req.query;
  
  try {
    const result = await NotificationService.getUserNotifications(userId, {
      page: parseInt(page as string) || 1,
      limit: parseInt(limit as string) || 20,
      onlyUnread: unread === 'true'
    });
    
    return res.status(200).json(result);
  } catch (error) {
    logger.error('Erreur lors de la récupération des notifications', { error });
    return res.status(500).json({ message: 'Erreur lors de la récupération des notifications' });
  }
});

/**
 * Marque une notification comme lue
 */
export const markNotificationAsRead = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const { id } = req.params;
  
  try {
    const notification = await NotificationService.markAsRead(id, userId);
    return res.status(200).json({ message: 'Notification marquée comme lue', notification });
  } catch (error) {
    logger.error('Erreur lors du marquage de la notification', { error });
    return res.status(404).json({ message: 'Notification non trouvée ou non autorisée' });
  }
});

/**
 * Marque toutes les notifications comme lues
 */
export const markAllNotificationsAsRead = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  
  try {
    const count = await NotificationService.markAllAsRead(userId);
    return res.status(200).json({ 
      message: 'Toutes les notifications ont été marquées comme lues',
      count
    });
  } catch (error) {
    logger.error('Erreur lors du marquage de toutes les notifications', { error });
    return res.status(500).json({ message: 'Erreur lors du marquage des notifications' });
  }
});

/**
 * Supprime une notification
 */
export const deleteNotification = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const { id } = req.params;
  
  try {
    await NotificationService.deleteNotification(id, userId);
    return res.status(200).json({ message: 'Notification supprimée avec succès' });
  } catch (error) {
    logger.error('Erreur lors de la suppression de la notification', { error });
    return res.status(404).json({ message: 'Notification non trouvée ou non autorisée' });
  }
});