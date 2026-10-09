import { Request, Response } from 'express';
import { asyncHandler } from '../../../commons/middlewares/errorMiddleware';
import { HttpError } from '../../../commons/utils/httpError';
import { notificationPreferencesUpdateSchema } from '../../notifications/notificationPreferences';
import {
  getNotificationPreferences,
  updateNotificationPreferences
} from '../services/notificationPreferencesService';

function sendHttpError(res: Response, error: unknown): Response {
  if (error instanceof HttpError) {
    return res.status(error.statusCode).json({ success: false, message: error.message });
  }
  throw error;
}

/**
 * Préférences de notification (catégorie × canal) du membre connecté
 * @route GET /api/users/me/notification-preferences
 * @access Private
 */
export const getMyNotificationPreferences = asyncHandler(async (req: Request, res: Response) => {
  try {
    const preferences = await getNotificationPreferences(req.user!.id);
    return res.status(200).json({ success: true, preferences });
  } catch (error) {
    return sendHttpError(res, error);
  }
});

/**
 * Met à jour tout ou partie des préférences de notification
 * @route PUT /api/users/me/notification-preferences
 * @access Private
 */
export const updateMyNotificationPreferences = asyncHandler(async (req: Request, res: Response) => {
  const parsed = notificationPreferencesUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      message: 'Préférences de notification invalides',
      details: parsed.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message }))
    });
  }

  try {
    const preferences = await updateNotificationPreferences(req.user!.id, parsed.data);
    return res.status(200).json({ success: true, message: 'Préférences de notification enregistrées', preferences });
  } catch (error) {
    return sendHttpError(res, error);
  }
});
