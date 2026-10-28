import Conversation from '../../../models/conversationModel';
import Message from '../../../models/messageModel';
import { realtimePublisher } from '../../realtime/services/realtimePublisher';
import type { ObjectIdLike } from './offerHistory';

export const MESSAGE_CONTENT_TYPE = {
  OFFER: 'offer',
  COUNTER_OFFER: 'counter_offer',
  SYSTEM_NOTIFICATION: 'system_notification'
} as const;

export type MessageContentType = typeof MESSAGE_CONTENT_TYPE[keyof typeof MESSAGE_CONTENT_TYPE];

/**
 * Crée le message système d'une action sur une offre, puis le message texte
 * optionnel de son auteur, et met à jour lastMessage / lastMessageAt de la conversation.
 */
export async function createOfferMessages(
  conversationId: ObjectIdLike,
  senderId: string,
  systemContent: string,
  contentType: MessageContentType,
  optionalUserMessage?: string
): Promise<void> {
  const systemMessage = await Message.create({
    conversation: conversationId,
    sender: senderId,
    content: systemContent,
    contentType,
    isSystemMessage: true,
    readBy: [senderId]
  });

  let lastMessageId = systemMessage._id;

  if (optionalUserMessage && optionalUserMessage.trim()) {
    const userMessage = await Message.create({
      conversation: conversationId,
      sender: senderId,
      content: optionalUserMessage,
      contentType: 'text',
      readBy: [senderId]
    });
    lastMessageId = userMessage._id;
  }

  await Conversation.findByIdAndUpdate(
    conversationId,
    { lastMessage: lastMessageId, lastMessageAt: new Date() }
  );
  realtimePublisher.publishNewMessages(conversationId, [systemMessage._id, lastMessageId]);
}
