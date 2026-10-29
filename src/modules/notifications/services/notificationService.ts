import Notification, { INotification } from '../../../models/notificationModel';
import User from '../../../models/userModel';
import mongoose from 'mongoose';
import logger from '../../../commons/utils/logger';
import { notFound } from '../../../commons/utils/httpError';
import { paginationMeta } from '../../../commons/utils/pagination';
import { sendToUser as sendPushToUser } from './pushService';
import { sendNotificationEmail, type NotificationEmail } from '../../../commons/services/emailService';
import { resolveDeliveryChannels } from '../notificationPreferences';
import { realtimePublisher } from '../../realtime/services/realtimePublisher';

const DEFAULT_EXPIRY_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const asOptionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined;

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

const notificationNotFound = () =>
  notFound('Notification non trouvée ou non autorisée', 'NOTIFICATION_NOT_FOUND');

/**
 * Suivi de colis porté par la notification d'expédition (cf. shipmentService) :
 * l'email l'affiche, ce qui évite un second email d'expédition dédié.
 */
function trackingFrom(data: Record<string, unknown>): NotificationEmail['tracking'] {
  const number = asOptionalString(data.trackingNumber);
  if (!number) return undefined;
  return { carrier: asOptionalString(data.carrier), number, url: asOptionalString(data.trackingUrl) };
}

export interface NotificationPayload {
  type: string;
  title: string;
  content: string;
  link?: string | null;
  data?: Record<string, unknown>;
  expiresInDays?: number;
}

/**
 * Crée une notification in-app, la pousse aux onglets ouverts du destinataire,
 * puis déclenche push et email selon ses préférences (sans les attendre).
 *
 * Ne lève jamais : un échec est journalisé et renvoie `null`. La notification
 * accompagne une action (paiement, litige, offre…) qui, elle, est déjà
 * enregistrée et ne doit pas échouer pour ça. Les appelants n'ont donc ni
 * `.catch` ni `try` à écrire.
 */
export async function createNotification({
  recipientId,
  type,
  title,
  content,
  link = null,
  data = {},
  expiresInDays = DEFAULT_EXPIRY_DAYS
}: NotificationPayload & { recipientId: string | mongoose.Types.ObjectId }) {
  try {
    // Seuls les champs utiles aux canaux externes sont chargés : cette
    // fonction est appelée à chaque action notifiée.
    const recipient = await User.findById(recipientId)
      .select('email username preferences.notifications')
      .lean();
    if (!recipient) {
      throw new Error(`Destinataire introuvable: ${recipientId}`);
    }

    const expiresAt = expiresInDays ? new Date(Date.now() + expiresInDays * DAY_MS) : undefined;

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

    // Onglets ouverts du destinataire (SSE) : la cloche se met à jour sans rechargement.
    realtimePublisher.publishNotification(recipientId, notification.toJSON());

    // Point unique de décision des canaux externes : le type donne la
    // catégorie, les préférences du destinataire tranchent (l'in-app reste
    // toujours créé ci-dessus).
    const channels = resolveDeliveryChannels(type, recipient.preferences?.notifications);

    // Push et email — fire-and-forget : un échec d'envoi ne doit ni
    // bloquer ni faire échouer l'opération métier qui notifie.
    if (channels.push) {
      sendPushToUser(recipientId.toString(), {
        title,
        body: content,
        link: link ?? undefined,
        data: { ...data, notificationId: notification._id, type }
      }).catch((error) => {
        logger.warn('Erreur push notification', {
          recipientId: recipientId.toString(),
          error: errorMessage(error)
        });
      });
    }

    if (channels.email && recipient.email) {
      sendNotificationEmail({
        to: recipient.email,
        username: recipient.username,
        title,
        content,
        link,
        tracking: trackingFrom(data)
      }).catch((error) => {
        logger.warn('Erreur email de notification', {
          recipientId: recipientId.toString(),
          type,
          error: errorMessage(error)
        });
      });
    }

    return notification;
  } catch (error) {
    logger.error('Erreur lors de la création de notification', {
      error: errorMessage(error),
      recipientId,
      type
    });
    return null;
  }
}

/**
 * Crée la même notification pour tous les administrateurs actifs.
 * Échec individuel ne bloque pas la diffusion (fire-and-forget par admin).
 * Utilisé pour les alertes nécessitant une action de modération
 * (litige ouvert, signalement urgent, etc.).
 */
export async function notifyAllAdmins(payload: NotificationPayload) {
  try {
    const admins = await User.find({ role: 'admin', accountStatus: 'active' }).select('_id').lean();
    const results = await Promise.all(
      admins.map((admin) => createNotification({ recipientId: admin._id, ...payload }))
    );
    const failed = results.filter((notification) => notification === null).length;
    if (failed > 0) {
      logger.warn('Notifications admin partielles', { sent: admins.length - failed, failed });
    }
    return { sent: admins.length - failed, failed };
  } catch (error) {
    logger.error('Erreur lors de la diffusion aux admins', {
      error: errorMessage(error),
      type: payload.type
    });
    // Nous voulons pas faire échouer l'opération métier appelante.
    return { sent: 0, failed: 0 };
  }
}

/**
 * Notifications d'un utilisateur, les plus récentes d'abord, avec le nombre
 * total de non lues (indépendant du filtre `onlyUnread`).
 */
export async function getUserNotifications(
  userId: string | mongoose.Types.ObjectId,
  { page = 1, limit = 20, onlyUnread = false }: { page?: number; limit?: number; onlyUnread?: boolean } = {}
) {
  const query: mongoose.QueryFilter<INotification> = { recipient: userId };
  if (onlyUnread) {
    query.isRead = false;
  }

  const [unreadCount, notifications, total] = await Promise.all([
    Notification.countDocuments({ recipient: userId, isRead: false }),
    Notification.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Notification.countDocuments(query)
  ]);

  return {
    notifications,
    unreadCount,
    pagination: paginationMeta({ page, limit }, total)
  };
}

/** @throws HttpError 404 NOTIFICATION_NOT_FOUND si elle n'existe pas ou appartient à un autre membre. */
export async function markAsRead(notificationId: string, userId: string) {
  if (!mongoose.Types.ObjectId.isValid(notificationId)) throw notificationNotFound();
  const notification = await Notification.findOneAndUpdate(
    { _id: notificationId, recipient: userId },
    { isRead: true },
    { returnDocument: 'after' }
  );

  if (!notification) {
    throw notificationNotFound();
  }

  return notification;
}

/** @returns le nombre de notifications passées en lues. */
export async function markAllAsRead(userId: string) {
  const result = await Notification.updateMany(
    { recipient: userId, isRead: false },
    { isRead: true }
  );

  return result.modifiedCount;
}

/** @throws HttpError 404 NOTIFICATION_NOT_FOUND si elle n'existe pas ou appartient à un autre membre. */
export async function deleteNotification(notificationId: string, userId: string) {
  if (!mongoose.Types.ObjectId.isValid(notificationId)) throw notificationNotFound();
  const notification = await Notification.findOneAndDelete({
    _id: notificationId,
    recipient: userId
  });

  if (!notification) {
    throw notificationNotFound();
  }

  return notification;
}
