import User from '../../../models/userModel';
import { HttpError } from '../../../commons/utils/httpError';
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNELS,
  resolveNotificationPreferences,
  type NotificationPreferences,
  type NotificationPreferencesUpdate
} from '../../notifications/notificationPreferences';

const NOTIFICATIONS_PATH = 'preferences.notifications';

/** Préférences effectives du membre (choix enregistrés complétés par les défauts). */
export async function getNotificationPreferences(userId: string): Promise<NotificationPreferences> {
  const user = await User.findById(userId).select(NOTIFICATIONS_PATH).lean();
  if (!user) {
    throw new HttpError(404, 'Utilisateur non trouvé');
  }
  return resolveNotificationPreferences(user.preferences?.notifications);
}

/**
 * Enregistre les choix transmis, canal par canal. Des `$set` ciblés plutôt
 * qu'un remplacement de `preferences` : une mise à jour concurrente du profil
 * (messages directs, groupes) n'est pas écrasée.
 */
export async function updateNotificationPreferences(
  userId: string,
  update: NotificationPreferencesUpdate
): Promise<NotificationPreferences> {
  const changes: Record<string, boolean> = {};
  for (const category of NOTIFICATION_CATEGORIES) {
    for (const channel of NOTIFICATION_CHANNELS) {
      const value = update[category]?.[channel];
      if (value !== undefined) changes[`${NOTIFICATIONS_PATH}.${category}.${channel}`] = value;
    }
  }

  const user = await User.findByIdAndUpdate(userId, { $set: changes }, { returnDocument: 'after' })
    .select(NOTIFICATIONS_PATH)
    .lean();
  if (!user) {
    throw new HttpError(404, 'Utilisateur non trouvé');
  }
  return resolveNotificationPreferences(user.preferences?.notifications);
}
