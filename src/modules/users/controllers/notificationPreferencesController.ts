import { Request, Response } from 'express';
import { badRequest } from '../../../commons/utils/httpError';
import { notificationPreferencesUpdateSchema } from '../../notifications/notificationPreferences';
import {
  getNotificationPreferences,
  updateNotificationPreferences
} from '../services/notificationPreferencesService';

/**
 * Préférences de notification (catégorie × canal) du membre connecté
 * @route GET /api/users/me/notification-preferences
 * @access Private
 */
export const getMyNotificationPreferences = async (req: Request, res: Response) => {
  const preferences = await getNotificationPreferences(req.user!.id);
  return res.status(200).json({ success: true, preferences });
};

/**
 * Met à jour tout ou partie des préférences de notification
 * @route PUT /api/users/me/notification-preferences
 * @access Private
 */
export const updateMyNotificationPreferences = async (req: Request, res: Response) => {
  const parsed = notificationPreferencesUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    throw badRequest('Préférences de notification invalides', 'VALIDATION_ERROR', {
      details: parsed.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message }))
    });
  }

  const preferences = await updateNotificationPreferences(req.user!.id, parsed.data);
  return res.status(200).json({ success: true, message: 'Préférences de notification enregistrées', preferences });
};
