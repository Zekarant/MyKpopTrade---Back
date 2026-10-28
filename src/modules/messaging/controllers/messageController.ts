import path from 'path';
import { Request, Response } from 'express';
import {
  sendMessageToConversation,
  markConversationRead,
  markSingleMessageRead,
  deleteUserMessage,
  resolveMessageAttachmentPath
} from '../services/messageOperationsService';
import { issueAttachmentReadToken, ATTACHMENT_TOKEN_TTL_SECONDS } from '../middleware/attachmentAuthMiddleware';

export { upload, discardAttachmentsOnRejection } from '../middleware/messageUploadConfig';

/**
 * Types affichables dans le navigateur. Toute autre extension (`.html`,
 * `.svg`…, possible sur d'anciennes pièces jointes) part en téléchargement.
 */
const INLINE_ATTACHMENT_TYPES = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.gif', 'image/gif'],
  ['.pdf', 'application/pdf']
]);

function setAttachmentHeaders(res: Response, fileName: string): void {
  // nosniff est posé sur toutes les réponses par securityHeaders.
  const inlineType = INLINE_ATTACHMENT_TYPES.get(path.extname(fileName).toLowerCase());
  if (inlineType) {
    res.type(inlineType);
    // La visionneuse PDF du navigateur est un plugin : la CSP d'API
    // (`default-src 'none'`, donc `object-src 'none'`) l'empêcherait de s'afficher.
    if (inlineType === 'application/pdf') res.removeHeader('Content-Security-Policy');
  } else {
    // `sendFile` ne remplace pas un Content-Type déjà posé.
    res.type('application/octet-stream');
    res.attachment();
  }
}

/**
 * Envoie un nouveau message dans une conversation
 */
export const sendNewMessage = async (req: Request, res: Response) => {
  const populatedMessage = await sendMessageToConversation({
    userId: req.user!.id,
    username: req.user?.username,
    conversationId: req.params.id as string,
    content: req.body?.content,
    files: Array.isArray(req.files) ? req.files : undefined
  });

  res.status(201).json({
    message: 'Message envoyé avec succès',
    data: populatedMessage
  });
};

/**
 * Marque tous les messages d'une conversation comme lus
 */
export const markConversationAsRead = async (req: Request, res: Response) => {
  const markedCount = await markConversationRead(req.user!.id, req.params.id as string);

  res.status(200).json({
    message: 'Messages marqués comme lus',
    markedCount
  });
};

/**
 * Marque un message spécifique comme lu
 */
export const markMessageAsRead = async (req: Request, res: Response) => {
  await markSingleMessageRead(req.user!.id, req.params.messageId as string);

  res.status(200).json({
    message: 'Message marqué comme lu'
  });
};

/**
 * Supprime un message pour l'utilisateur actuel uniquement
 */
export const deleteMessage = async (req: Request, res: Response) => {
  await deleteUserMessage(req.user!.id, req.params.id as string);

  res.status(200).json({
    message: 'Message supprimé avec succès'
  });
};

/**
 * Jeton de lecture des pièces jointes, à placer dans leurs URL (<img src>).
 */
export const createAttachmentToken = (req: Request, res: Response) => {
  res.status(200).json({
    token: issueAttachmentReadToken(req.user!.id),
    expiresIn: ATTACHMENT_TOKEN_TTL_SECONDS
  });
};

/**
 * Récupère les fichiers joints à un message
 */
export const getMessageAttachment = async (req: Request, res: Response) => {
  const filePath = await resolveMessageAttachmentPath({
    userId: req.user!.id,
    messageId: req.params.messageId as string,
    attachmentName: req.params.attachment as string
  });

  setAttachmentHeaders(res, filePath);
  res.sendFile(filePath);
};
