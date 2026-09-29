import { Request, Response } from 'express';
import { asyncHandler } from '../../../commons/middlewares/errorMiddleware';
import { NotificationService } from '../services/notificationService';
import logger from '../../../commons/utils/logger';
import { clampLimit } from '../../../commons/utils/pagination';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

/**
 * Récupère les notifications de l'utilisateur connecté
 */
export const getMyNotifications = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { page = '1', limit, unread } = req.query;

  try {
    const result = await NotificationService.getUserNotifications(userId, {
      page: Math.max(1, parseInt(page as string) || 1),
      limit: clampLimit(limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
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
  const userId = req.user!.id;
  const id = req.params.id as string;
  
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
  const userId = req.user!.id;
  
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
  const userId = req.user!.id;
  const id = req.params.id as string;
  
  try {
    await NotificationService.deleteNotification(id, userId);
    return res.status(200).json({ message: 'Notification supprimée avec succès' });
  } catch (error) {
    logger.error('Erreur lors de la suppression de la notification', { error });
    return res.status(404).json({ message: 'Notification non trouvée ou non autorisée' });
  }
});