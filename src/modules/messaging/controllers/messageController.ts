import { Request, Response } from 'express';
import { asyncHandler } from '../../../commons/middlewares/errorMiddleware';
import { mapHttpError } from '../../../commons/utils/httpErrorMapper';
import logger from '../../../commons/utils/logger';
import {
  sendMessageToConversation,
  markConversationRead,
  markSingleMessageRead,
  deleteUserMessage,
  resolveMessageAttachmentPath
} from '../services/messageOperationsService';

export { upload } from '../middleware/messageUploadConfig';

/**
 * Envoie un nouveau message dans une conversation
 */
export const sendNewMessage = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const username = (req.user as any)?.username;
  const conversationId = req.params.id as string;
  const { content, contentType = 'text' } = req.body;
  const files = Array.isArray(req.files) ? (req.files as Express.Multer.File[]) : undefined;

  try {
    const populatedMessage = await sendMessageToConversation({
      userId,
      username,
      conversationId,
      content,
      contentType,
      files
    });

    return res.status(201).json({
      message: 'Message envoyé avec succès',
      data: populatedMessage
    });
  } catch (error) {
    const mapped = mapHttpError(res, error);
    if (mapped) return mapped;

    logger.error('Erreur lors de l\'envoi d\'un message', { error, conversationId, userId });
    return res.status(500).json({
      message: error instanceof Error ? error.message : 'Une erreur est survenue'
    });
  }
});

/**
 * Marque tous les messages d'une conversation comme lus
 */
export const markConversationAsRead = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const conversationId = req.params.id as string;

  try {
    const markedCount = await markConversationRead(userId, conversationId);

    return res.status(200).json({
      message: 'Messages marqués comme lus',
      markedCount
    });
  } catch (error) {
    const mapped = mapHttpError(res, error);
    if (mapped) return mapped;

    logger.error('Erreur lors du marquage des messages comme lus', { error, conversationId, userId });
    return res.status(500).json({
      message: error instanceof Error ? error.message : 'Une erreur est survenue'
    });
  }
});

/**
 * Marque un message spécifique comme lu
 */
export const markMessageAsRead = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const messageId = req.params.messageId as string;

  try {
    await markSingleMessageRead(userId, messageId);

    return res.status(200).json({
      message: 'Message marqué comme lu'
    });
  } catch (error) {
    const mapped = mapHttpError(res, error);
    if (mapped) return mapped;

    logger.error('Erreur lors du marquage d\'un message comme lu', { error, userId, messageId });
    return res.status(500).json({ message: 'Une erreur est survenue' });
  }
});

/**
 * Supprime un message pour l'utilisateur actuel uniquement
 */
export const deleteMessage = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const messageId = req.params.id as string;

  try {
    await deleteUserMessage(userId, messageId);

    return res.status(200).json({
      message: 'Message supprimé avec succès'
    });
  } catch (error: any) {
    const mapped = mapHttpError(res, error);
    if (mapped) return mapped;

    logger.error('Erreur lors de la suppression d\'un message', { error });
    return res.status(500).json({ message: error.message });
  }
});

/**
 * Récupère les fichiers joints à un message
 */
export const getMessageAttachment = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const messageId = req.params.messageId as string;
  const attachmentName = req.params.attachment as string;

  try {
    const filePath = await resolveMessageAttachmentPath({
      userId,
      messageId,
      attachmentName
    });

    return res.sendFile(filePath);
  } catch (error: any) {
    const mapped = mapHttpError(res, error);
    if (mapped) return mapped;

    logger.error('Erreur lors de la récupération d\'une pièce jointe', { error });
    return res.status(500).json({ message: error.message });
  }
});
