import path from 'path';
import fs from 'fs';
import Message from '../../../models/messageModel';
import Conversation from '../../../models/conversationModel';
import { NotificationService } from '../../notifications/services/notificationService';
import { MessagingUtilsService } from './messagingUtilsService';
import { HttpError } from '../../../commons/utils/httpError';
import logger from '../../../commons/utils/logger';

const VALID_CONTENT_TYPES = ['text', 'system_notification', 'offer', 'counter_offer', 'shipping_update'];
const ATTACHMENTS_DIR = () => path.join(process.cwd(), 'uploads', 'chat_attachments');

export async function sendMessageToConversation({
  userId,
  username,
  conversationId,
  content,
  contentType,
  files
}: {
  userId: string;
  username?: string;
  conversationId: string;
  content: unknown;
  contentType: string;
  files?: Express.Multer.File[];
}) {
  if (typeof content !== 'string' || content.trim() === '') {
    throw new HttpError(400, 'Le contenu du message ne peut pas être vide');
  }

  const conversation = await MessagingUtilsService.verifyConversationAccess(conversationId, userId);

  let attachments: string[] = [];
  if (files && Array.isArray(files) && files.length > 0) {
    for (const file of files) {
      if (!MessagingUtilsService.validateFileType(file.mimetype)) {
        throw new HttpError(400, `Type de fichier non autorisé: ${file.mimetype}`);
      }
    }

    attachments = files.map(file => file.filename);
    logger.debug(`Fichiers traités: ${attachments.join(', ')}`);
  }

  const resolvedContentType = VALID_CONTENT_TYPES.includes(contentType) ? contentType : 'text';

  const newMessage = await Message.create({
    conversation: conversationId,
    sender: userId,
    content,
    contentType: resolvedContentType,
    attachments: attachments.length > 0 ? attachments : undefined,
    readBy: [userId]
  });

  await MessagingUtilsService.updateConversationLastMessage(conversationId, newMessage._id.toString());

  const otherParticipants = conversation.participants.filter(
    (p: any) => p.toString() !== userId
  );

  const senderName = username || 'Utilisateur';

  for (const recipientId of otherParticipants) {
    await NotificationService.createNotification({
      recipientId,
      type: 'message',
      title: 'Nouveau message',
      content: `Vous avez reçu un nouveau message de ${senderName}`,
      link: `/conversations/${conversationId}`,
      data: {
        conversationId,
        messageId: newMessage._id,
        sender: { id: userId, username: senderName }
      }
    });
  }

  return await Message.findById(newMessage._id)
    .populate('sender', 'username profilePicture');
}

export async function markConversationRead(userId: string, conversationId: string) {
  await MessagingUtilsService.verifyConversationAccess(conversationId, userId);
  return await MessagingUtilsService.markConversationAsRead(conversationId, userId);
}

export async function markSingleMessageRead(userId: string, messageId: string) {
  const message = await Message.findById(messageId);

  if (!message) {
    throw new HttpError(404, 'Message non trouvé');
  }

  const conversation = await Conversation.findOne({
    _id: message.conversation,
    participants: userId
  });

  if (!conversation) {
    throw new HttpError(403, 'Accès refusé à ce message');
  }

  if (!message.readBy.includes(userId)) {
    await Message.findByIdAndUpdate(
      messageId,
      { $addToSet: { readBy: userId } }
    );
  }
}

export async function deleteUserMessage(userId: string, messageId: string) {
  const message = await Message.findOne({
    _id: messageId,
    sender: userId,
    isDeleted: false
  });

  if (!message) {
    throw new HttpError(404, 'Message non trouvé ou accès refusé');
  }

  if (message.readBy.length > 1) {
    await Message.updateOne(
      { _id: messageId },
      {
        isDeleted: true,
        deletedAt: new Date(),
        content: '[Message supprimé]',
        attachments: []
      }
    );
  } else {
    if (message.attachments && message.attachments.length > 0) {
      for (const attachment of message.attachments) {
        const filePath = path.join(ATTACHMENTS_DIR(), attachment);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      }
    }

    await Message.deleteOne({ _id: messageId });
  }
}

export async function resolveMessageAttachmentPath({
  userId,
  messageId,
  attachmentName
}: {
  userId: string;
  messageId: string;
  attachmentName: string;
}): Promise<string> {
  const message = await Message.findOne({ _id: messageId });

  if (!message) {
    throw new HttpError(404, 'Message non trouvé');
  }

  const conversation = await Conversation.findOne({
    _id: message.conversation,
    participants: userId
  });

  if (!conversation) {
    throw new HttpError(403, 'Accès refusé');
  }

  if (!message.attachments || !message.attachments.includes(attachmentName)) {
    throw new HttpError(404, 'Pièce jointe non trouvée');
  }

  const filePath = path.join(ATTACHMENTS_DIR(), attachmentName);

  if (!fs.existsSync(filePath)) {
    throw new HttpError(404, 'Fichier non trouvé sur le serveur');
  }

  return filePath;
}
