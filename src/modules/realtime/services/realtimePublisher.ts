import mongoose from 'mongoose';
import Conversation from '../../../models/conversationModel';
import Message from '../../../models/messageModel';
import Notification from '../../../models/notificationModel';
import logger from '../../../commons/utils/logger';
import { realtimeHub, type RealtimeHub } from '../realtimeHub';

/**
 * Événements poussés aux clients. Les noms sont un contrat avec le front
 * (src/services/realtime.ts) : ne pas les renommer sans le mettre à jour.
 */
export const REALTIME_EVENTS = {
  MESSAGE_NEW: 'message:new',
  CONVERSATION_READ: 'conversation:read',
  NOTIFICATION_NEW: 'notification:new',
  UNREAD_UPDATE: 'unread:update'
} as const;

type Id = string | mongoose.Types.ObjectId;

export interface UnreadCounts {
  messages: number;
  notifications: number;
}

/**
 * Messages non lus de toutes les conversations visibles par l'utilisateur
 * (mêmes critères que la liste des conversations) et notifications non lues.
 */
export async function computeUnreadCounts(userId: string): Promise<UnreadCounts> {
  const me = new mongoose.Types.ObjectId(userId);
  const conversationIds = await Conversation.find({
    participants: me,
    isActive: true,
    deletedBy: { $ne: me }
  }).distinct('_id');

  const [messages, notifications] = await Promise.all([
    Message.countDocuments({
      conversation: { $in: conversationIds },
      sender: { $ne: me },
      readBy: { $ne: me },
      isDeleted: false
    }),
    Notification.countDocuments({ recipient: me, isRead: false })
  ]);
  return { messages, notifications };
}

/**
 * Le temps réel est un bonus : son échec (base indisponible, flux fermé) ne
 * doit jamais faire échouer l'opération métier qui l'a déclenché. Les
 * publications sont donc lancées sans être attendues et journalisent leurs erreurs.
 */
function runDetached(event: string, task: () => Promise<void>): void {
  task().catch((error) => {
    logger.warn('realtime.publish_failed', {
      event,
      error: error instanceof Error ? error.message : String(error)
    });
  });
}

export function createRealtimePublisher(hub: RealtimeHub) {
  async function publishUnreadCountsNow(userId: string): Promise<void> {
    if (!hub.isConnected(userId)) return;
    hub.publish(userId, REALTIME_EVENTS.UNREAD_UPDATE, await computeUnreadCounts(userId));
  }

  return {
    /**
     * Pousse des messages venant d'être créés à tous les participants, auteur
     * compris : ses autres onglets les affichent aussi. Les messages sont
     * relus peuplés, dans la même forme que GET /api/messaging/:id.
     */
    publishNewMessages(conversationId: Id, messageIds: Id[]): void {
      // Sans aucun client connecté, inutile de relire quoi que ce soit.
      if (!hub.hasConnections()) return;

      runDetached(REALTIME_EVENTS.MESSAGE_NEW, async () => {
        const conversation = await Conversation.findById(conversationId).select('participants').lean();
        const recipients = (conversation?.participants ?? [])
          .map(String)
          .filter((participantId) => hub.isConnected(participantId));
        if (recipients.length === 0) return;

        const messages = await Message.find({ _id: { $in: messageIds } })
          .sort({ createdAt: 1 })
          .populate('sender', 'username profilePicture')
          .lean();

        for (const recipientId of recipients) {
          for (const message of messages) {
            hub.publish(recipientId, REALTIME_EVENTS.MESSAGE_NEW, {
              conversationId: String(conversationId),
              message
            });
          }
        }
      });
    },

    /**
     * Accusé de lecture : `readerId` a lu les messages de la conversation
     * (`messageIds` absent = tous ceux qu'il n'avait pas écrits). Les autres
     * onglets du lecteur reçoivent aussi ses compteurs à jour.
     */
    publishConversationRead(params: {
      conversationId: Id;
      readerId: string;
      participantIds: Id[];
      messageIds?: Id[];
    }): void {
      const payload = {
        conversationId: String(params.conversationId),
        readerId: params.readerId,
        ...(params.messageIds && { messageIds: params.messageIds.map(String) }),
        readAt: new Date().toISOString()
      };
      for (const participantId of params.participantIds) {
        hub.publish(String(participantId), REALTIME_EVENTS.CONVERSATION_READ, payload);
      }
      runDetached(REALTIME_EVENTS.UNREAD_UPDATE, () => publishUnreadCountsNow(params.readerId));
    },

    publishNotification(recipientId: Id, notification: unknown): void {
      hub.publish(String(recipientId), REALTIME_EVENTS.NOTIFICATION_NEW, notification);
    },

    /** Compteurs complets, à l'ouverture d'un flux : resynchronise après une coupure. */
    publishUnreadCounts(userId: string): void {
      runDetached(REALTIME_EVENTS.UNREAD_UPDATE, () => publishUnreadCountsNow(userId));
    }
  };
}

export const realtimePublisher = createRealtimePublisher(realtimeHub);
