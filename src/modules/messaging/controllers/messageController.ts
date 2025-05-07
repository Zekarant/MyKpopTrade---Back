import { Request, Response } from 'express';
import { asyncHandler } from '../../../commons/middlewares/errorMiddleware';
import Message from '../../../models/messageModel';
import Conversation from '../../../models/conversationModel';
import { sendMessage } from '../services/messageService';
import logger from '../../../commons/utils/logger';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

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
  
  // Vérifier que le contenu n'est pas vide
  if (!content || content.trim() === '') {
    return res.status(400).json({ message: 'Le contenu du message ne peut pas être vide' });
  }
  
  try {
    // Vérifier l'accès à la conversation
    const conversation = await Conversation.findOne({
      _id: conversationId,
      participants: userId,
      status: 'open',
      isActive: true
    });
    
    if (!conversation) {
      return res.status(404).json({ message: 'Conversation non trouvée ou accès refusé' });
    }
    
    // Gérer les pièces jointes
    let attachments: string[] = [];
    if (req.files && Array.isArray(req.files)) {
      attachments = (req.files as Express.Multer.File[]).map(file => file.filename);
    } else if (req.file) {
      attachments = [req.file.filename];
    }
    
    // Construire les métadonnées du message si nécessaire
    const metadata: any = {};
    
    // Créer et envoyer le message
    const newMessage = await sendMessage({
      conversationId,
      senderId: userId,
      content,
      attachments,
      contentType,
      metadata
    });
    
    return res.status(201).json({
      message: 'Message envoyé avec succès',
      data: newMessage
    });
  } catch (error: any) {
    logger.error('Erreur lors de l\'envoi d\'un message', { error });
    return res.status(500).json({ message: error.message });
  }
});

/**
 * Marque tous les messages d'une conversation comme lus
 */
export const markConversationAsRead = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const conversationId = req.params.id;
  
  try {
    // Vérifier l'accès à la conversation
    const conversation = await Conversation.findOne({
      _id: conversationId,
      participants: userId
    });
    
    if (!conversation) {
      return res.status(404).json({ message: 'Conversation non trouvée ou accès refusé' });
    }
    
    // Marquer tous les messages comme lus
    const result = await Message.updateMany(
      {
        conversation: conversationId,
        readBy: { $ne: userId }
      },
      { $addToSet: { readBy: userId } }
    );
    
    return res.status(200).json({
      message: 'Messages marqués comme lus',
      count: result.modifiedCount
    });
  } catch (error: any) {
    logger.error('Erreur lors du marquage des messages comme lus', { error });
    return res.status(500).json({ message: error.message });
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