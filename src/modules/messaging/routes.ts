import express from 'express';
import * as conversationController from './controllers/conversationController';
import * as messageController from './controllers/messageController';
import { authenticateJWT } from '../../commons/middlewares/authMiddleware';
import { sanitizeInputs } from '../../commons/middlewares/sanitizeMiddleware';
import {
  rateLimitMessages,
  verifyConversationAccess,
  validateMessageContent
} from './middleware/messageSecurityMiddleware';

const router = express.Router();

// Appliquer la sanitisation globalement pour toutes les routes de messagerie
router.use(sanitizeInputs);

// Routes des conversations
router.get(
  '/',
  authenticateJWT,
  conversationController.getUserConversations
);

router.get(
  '/:id',
  authenticateJWT,
  verifyConversationAccess,
  conversationController.getConversation
);

router.post(
  '/',
  authenticateJWT,
  conversationController.startConversation
);

// Routes des négociations
router.post(
  '/negotiate',
  authenticateJWT,
  conversationController.initiateNegotiation
);

router.post(
  '/:id/respond',
  authenticateJWT,
  verifyConversationAccess,
  conversationController.respondToNegotiation
);

// Routes Pay What You Want
router.post(
  '/pwyw',
  authenticateJWT,
  conversationController.initiatePayWhatYouWant
);

router.post(
  '/:id/pwyw-offer',
  authenticateJWT,
  verifyConversationAccess,
  conversationController.makePayWhatYouWantProposal
);

// Routes des messages
router.post(
  '/:id/messages',
  authenticateJWT,
  verifyConversationAccess,
  // Important: le middleware de validation doit venir APRÈS l'upload pour que req.body soit correctement rempli
  messageController.upload.array('attachments', 5), // Accepter jusqu'à 5 pièces jointes
  // Ne pas utiliser validateMessageContent ici car il vérifie avant que multer n'ait traité les données
  rateLimitMessages,
  messageController.sendNewMessage
);

router.put(
  '/:id/read',
  authenticateJWT,
  verifyConversationAccess,
  messageController.markConversationAsRead
);

router.put(
  '/messages/:messageId/read',
  authenticateJWT,
  messageController.markMessageAsRead
);

router.delete(
  '/messages/:id',
  authenticateJWT,
  // Nous aurons besoin d'un middleware spécifique pour vérifier que l'utilisateur est bien le propriétaire du message
  messageController.deleteMessage
);

router.get(
  '/messages/:messageId/attachments/:attachment',
  authenticateJWT,
  // Middleware de vérification des droits d'accès à la pièce jointe
  messageController.getMessageAttachment
);

// Ajouter cette route pour récupérer les médias d'une conversation
router.get(
  '/:id/media',
  authenticateJWT,
  verifyConversationAccess,
  conversationController.getConversationMedia
);

export default router;