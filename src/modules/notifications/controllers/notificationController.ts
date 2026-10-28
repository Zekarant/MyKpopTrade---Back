import { Request, Response } from 'express';
import {
  getUserNotifications,
  markAsRead,
  markAllAsRead,
  deleteNotification as deleteUserNotification
} from '../services/notificationService';
import { parsePagination } from '../../../commons/utils/pagination';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

/**
 * Récupère les notifications de l'utilisateur connecté
 */
export const getMyNotifications = async (req: Request, res: Response) => {
  const { page, limit } = parsePagination(req.query, { defaultLimit: DEFAULT_PAGE_SIZE, maxLimit: MAX_PAGE_SIZE });

  const result = await getUserNotifications(req.user!.id, {
    page,
    limit,
    onlyUnread: req.query.unread === 'true'
  });

  res.status(200).json(result);
};

/**
 * Marque une notification comme lue
 */
export const markNotificationAsRead = async (req: Request, res: Response) => {
  const notification = await markAsRead(req.params.id as string, req.user!.id);
  res.status(200).json({ message: 'Notification marquée comme lue', notification });
};

/**
 * Marque toutes les notifications comme lues
 */
export const markAllNotificationsAsRead = async (req: Request, res: Response) => {
  const count = await markAllAsRead(req.user!.id);
  res.status(200).json({
    message: 'Toutes les notifications ont été marquées comme lues',
    count
  });
};

/**
 * Supprime une notification
 */
export const deleteNotification = async (req: Request, res: Response) => {
  await deleteUserNotification(req.params.id as string, req.user!.id);
  res.status(200).json({ message: 'Notification supprimée avec succès' });
};
