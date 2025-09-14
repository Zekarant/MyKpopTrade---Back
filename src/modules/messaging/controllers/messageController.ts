import { Request, Response } from 'express';
import { asyncHandler } from '../../../commons/middlewares/errorMiddleware';
import Message from '../../../models/messageModel';
import Conversation from '../../../models/conversationModel';
import logger from '../../../commons/utils/logger';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { NotificationService } from '../../notifications/services/notificationService';
import { MessagingUtilsService } from '../services/messagingUtilsService';

// Configuration de multer pour les pièces jointes
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const dir = path.join(process.cwd(), 'uploads', 'chat_attachments');
    // Créer le dossier s'il n'existe pas
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    cb(null, dir);
  },
  filename: function (req, file, cb) {
    // Générer un nom de fichier sécurisé
    const randomName = crypto.randomBytes(16).toString('hex');
    // Conserver l'extension du fichier
    const extension = path.extname(file.originalname);
    cb(null, `${randomName}${extension}`);
  }
});

// Filtrer les types de fichiers
const fileFilter = (req: any, file: any, cb: any) => {
  const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'application/pdf'];
  
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Type de fichier non pris en charge. Seuls JPEG, PNG, GIF et PDF sont autorisés.'), false);
  }
};

export const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB max
  }
});

/**
 * Envoie un nouveau message dans une conversation
 */
export const sendNewMessage = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const conversationId = req.params.id;
  const { content, contentType = 'text' } = req.body;
  
  // Validation du contenu
  if (typeof content !== 'string' || content.trim() === '') {
    return res.status(400).json({ message: 'Le contenu du message ne peut pas être vide' });
  }
  
  try {
    // Vérifier l'accès avec le service utilitaire
    const conversation = await MessagingUtilsService.verifyConversationAccess(conversationId, userId);
    
    // Traiter les pièces jointes
    let attachments: string[] = [];
    if (req.files && Array.isArray(req.files) && req.files.length > 0) {
      // Valider les types de fichiers
      for (const file of req.files) {
        if (!MessagingUtilsService.validateFileType(file.mimetype)) {
          return res.status(400).json({ 
            message: `Type de fichier non autorisé: ${file.mimetype}` 
          });
        }
      }
      
      attachments = req.files.map((file: Express.Multer.File) => file.filename);
      logger.debug(`Fichiers traités: ${attachments.join(', ')}`);
    }
    
    // Créer le message
    const newMessage = await Message.create({
      conversation: conversationId,
      sender: userId,
      content,
      contentType: ['text', 'system_notification', 'offer', 'counter_offer', 'shipping_update'].includes(contentType) 
        ? contentType : 'text',
      attachments: attachments.length > 0 ? attachments : undefined,
      readBy: [userId]
    });
    
    // Mettre à jour la conversation avec le service utilitaire
    await MessagingUtilsService.updateConversationLastMessage(conversationId, newMessage._id.toString());
    
    // Notifier les autres participants
    const otherParticipants = conversation.participants.filter(
      (p: any) => p.toString() !== userId
    );
    
    const username = (req.user as any)?.username || 'Utilisateur';
    
    for (const recipientId of otherParticipants) {
      await NotificationService.createNotification({
        recipientId,
        type: 'message',
        title: 'Nouveau message',
        content: `Vous avez reçu un nouveau message de ${username}`,
        link: `/conversations/${conversationId}`,
        data: { 
          conversationId,
          messageId: newMessage._id,
          sender: { id: userId, username }
        }
      });
    }
    
    // Récupérer le message avec les relations
    const populatedMessage = await Message.findById(newMessage._id)
      .populate('sender', 'username profilePicture');
    
    return res.status(201).json({
      message: 'Message envoyé avec succès',
      data: populatedMessage
    });
  } catch (error) {
    logger.error('Erreur lors de l\'envoi d\'un message', { error, conversationId, userId });
    return res.status(500).json({ 
      message: error instanceof Error ? error.message : 'Une erreur est survenue'
    });
  }
});

/**
 * Marque tous les messages d'une conversation comme lus - SIMPLIFIÉ
 */
export const markConversationAsRead = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const conversationId = req.params.id;
  
  try {
    // Vérifier l'accès avec le service utilitaire
    await MessagingUtilsService.verifyConversationAccess(conversationId, userId);
    
    // Marquer comme lu avec le service utilitaire
    const markedCount = await MessagingUtilsService.markConversationAsRead(conversationId, userId);
    
    return res.status(200).json({
      message: 'Messages marqués comme lus',
      markedCount
    });
  } catch (error) {
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
  const messageId = req.params.messageId;
  
  try {
    const message = await Message.findById(messageId);
    
    if (!message) {
      return res.status(404).json({ message: 'Message non trouvé' });
    }
    
    const conversation = await Conversation.findOne({
      _id: message.conversation,
      participants: userId
    });
    
    if (!conversation) {
      return res.status(403).json({ message: 'Accès refusé à ce message' });
    }
    
    if (!message.readBy.includes(userId)) {
      await Message.findByIdAndUpdate(
        messageId,
        { $addToSet: { readBy: userId } }
      );
    }
    
    return res.status(200).json({
      message: 'Message marqué comme lu'
    });
  } catch (error) {
    logger.error('Erreur lors du marquage d\'un message comme lu', { error, userId, messageId });
    return res.status(500).json({ message: 'Une erreur est survenue' });
  }
});

/**
 * Supprime un message pour l'utilisateur actuel uniquement
 */
export const deleteMessage = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const messageId = req.params.id;
  
  try {
    // Récupérer le message et vérifier qu'il appartient à l'utilisateur
    const message = await Message.findOne({
      _id: messageId,
      sender: userId,
      isDeleted: false
    });
    
    if (!message) {
      return res.status(404).json({ message: 'Message non trouvé ou accès refusé' });
    }
    
    // Si le message a été lu par d'autres utilisateurs, le marquer comme supprimé
    // Sinon, le supprimer complètement
    if (message.readBy.length > 1) {
      await Message.updateOne(
        { _id: messageId },
        { 
          isDeleted: true, 
          deletedAt: new Date(),
          content: '[Message supprimé]',
          attachments: [] // Supprimer les pièces jointes
        }
      );
    } else {
      // Supprimer les fichiers si nécessaire
      if (message.attachments && message.attachments.length > 0) {
        message.attachments.forEach((attachment: string) => {
          const filePath = path.join(process.cwd(), 'uploads', 'chat_attachments', attachment);
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
        });
      }
      
      await Message.deleteOne({ _id: messageId });
    }
    
    return res.status(200).json({
      message: 'Message supprimé avec succès'
    });
  } catch (error: any) {
    logger.error('Erreur lors de la suppression d\'un message', { error });
    return res.status(500).json({ message: error.message });
  }
});

/**
 * Récupère les fichiers joints à un message
 */
export const getMessageAttachment = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const messageId = req.params.messageId;
  const attachmentName = req.params.attachment;
  
  try {
    // Vérifier que l'utilisateur a accès au message
    const message = await Message.findOne({ _id: messageId });
    
    if (!message) {
      return res.status(404).json({ message: 'Message non trouvé' });
    }
    
    // Vérifier que l'utilisateur fait partie de la conversation
    const conversation = await Conversation.findOne({
      _id: message.conversation,
      participants: userId
    });
    
    if (!conversation) {
      return res.status(403).json({ message: 'Accès refusé' });
    }
    
    // Vérifier que la pièce jointe existe dans le message
    if (!message.attachments || !message.attachments.includes(attachmentName)) {
      return res.status(404).json({ message: 'Pièce jointe non trouvée' });
    }
    
    // Envoyer le fichier
    const filePath = path.join(process.cwd(), 'uploads', 'chat_attachments', attachmentName);
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ message: 'Fichier non trouvé sur le serveur' });
    }
    
    return res.sendFile(filePath);
  } catch (error: any) {
    logger.error('Erreur lors de la récupération d\'une pièce jointe', { error });
    return res.status(500).json({ message: error.message });
  }
});