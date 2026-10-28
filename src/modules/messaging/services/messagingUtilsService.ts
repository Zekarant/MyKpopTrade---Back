import mongoose from 'mongoose';
import path from 'path';
import Message from '../../../models/messageModel';
import Conversation from '../../../models/conversationModel';
import logger from '../../../commons/utils/logger';
import { notFound } from '../../../commons/utils/httpError';

type MediaMessage = {
  _id: mongoose.Types.ObjectId;
  attachments?: string[];
  createdAt: Date;
  sender: unknown;
};

type MessagePreviewSource = {
  content: string;
  contentType?: string;
  isEncrypted?: boolean;
};

const ALLOWED_ATTACHMENT_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain'
];

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];

const PREVIEW_MAX_LENGTH = 50;

const CATEGORY_LABELS = new Map([
  ['album', 'Album'],
  ['photocard', 'Photocard'],
  ['poster', 'Poster'],
  ['lightstick', 'Lightstick'],
  ['clothing', 'Vêtements'],
  ['accessories', 'Accessoires'],
  ['limited_edition', 'Édition Limitée'],
  ['other', 'Autre']
]);

/**
 * Conversation active dont l'utilisateur est participant.
 * @throws HttpError 404 CONVERSATION_NOT_FOUND sinon (absente, close, ou pas participant).
 */
export async function verifyConversationAccess(conversationId: string, userId: string) {
  const conversation = await Conversation.findOne({
    _id: conversationId,
    participants: userId,
    isActive: true
  });

  if (!conversation) {
    throw notFound('Conversation non trouvée ou accès refusé', 'CONVERSATION_NOT_FOUND');
  }

  return conversation;
}

/**
 * Marque tous les messages non lus d'une conversation comme lus.
 * Un échec est journalisé et compte zéro message : la lecture de la conversation ne doit pas échouer pour ça.
 */
export async function markConversationAsRead(conversationId: string, userId: string) {
  try {
    const result = await Message.updateMany(
      {
        conversation: new mongoose.Types.ObjectId(conversationId),
        sender: { $ne: new mongoose.Types.ObjectId(userId) },
        readBy: { $ne: new mongoose.Types.ObjectId(userId) },
        isDeleted: false
      },
      { $addToSet: { readBy: new mongoose.Types.ObjectId(userId) } }
    );

    logger.info(`${result.modifiedCount} messages marqués comme lus pour l'utilisateur ${userId}`);
    return result.modifiedCount;
  } catch (error) {
    logger.error('Erreur lors du marquage des messages comme lus', { error, conversationId, userId });
    return 0;
  }
}

/** Une entrée par pièce jointe, classée image / document / autre selon son extension. */
export function formatConversationMedia(mediaMessages: MediaMessage[]) {
  return mediaMessages.flatMap(msg =>
    (msg.attachments ?? []).map(attachment => {
      const extension = path.extname(attachment).toLowerCase();
      const isImage = IMAGE_EXTENSIONS.includes(extension);
      const isPDF = extension === '.pdf';

      return {
        filename: attachment,
        originalName: attachment,
        url: `/api/messaging/messages/${msg._id}/attachments/${attachment}`,
        type: isImage ? 'image' : isPDF ? 'document' : 'other',
        extension,
        uploadedAt: msg.createdAt,
        uploadedBy: msg.sender,
        messageId: msg._id.toString(),
        size: null
      };
    })
  );
}

export async function updateConversationLastMessage(conversationId: string, messageId: string) {
  await Conversation.findByIdAndUpdate(conversationId, {
    lastMessage: messageId,
    lastMessageAt: new Date(),
    status: 'open'
  });
}

export function validateFileType(mimetype: string): boolean {
  return ALLOWED_ATTACHMENT_MIME_TYPES.includes(mimetype);
}

/** Aperçu affiché dans la liste des conversations, selon le type du message. */
export function generateMessagePreview(message: MessagePreviewSource | null | undefined): string {
  if (!message) return '';

  if (message.isEncrypted) {
    return '[Message chiffré]';
  }

  switch (message.contentType) {
    case 'system_notification':
      return message.content;
    case 'offer':
      return '💰 Nouvelle offre';
    case 'counter_offer':
      return '🔄 Contre-offre';
    case 'shipping_update':
      return '📦 Mise à jour expédition';
    default:
      return message.content.length > PREVIEW_MAX_LENGTH
        ? message.content.substring(0, PREVIEW_MAX_LENGTH) + '...'
        : message.content;
  }
}

/** Libellé français d'une catégorie de produit ; la catégorie brute si elle est inconnue. */
export function formatCategory(category: string): string {
  return CATEGORY_LABELS.get(category) ?? category;
}
