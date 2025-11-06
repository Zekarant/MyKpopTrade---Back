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

// ✅ NOUVELLES ROUTES - Gestion des conversations
router.delete(
  '/:id',
  authenticateJWT,
  verifyConversationAccess,
  conversationController.deleteConversation
);

router.put(
  '/:id/archive',
  authenticateJWT,
  verifyConversationAccess,
  conversationController.archiveConversation
);

router.put(
  '/:id/unarchive',
  authenticateJWT,
  verifyConversationAccess,
  conversationController.unarchiveConversation
);

router.put(
  '/:id/favorite',
  authenticateJWT,
  verifyConversationAccess,
  conversationController.toggleFavoriteConversation
);

router.get(
  '/:id/offers',
  authenticateJWT,
  verifyConversationAccess,
  conversationController.getConversationOffers
);

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
  messageController.upload.array('attachments', 5),
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
  messageController.deleteMessage
);

router.get(
  '/messages/:messageId/attachments/:attachment',
  authenticateJWT,
  messageController.getMessageAttachment
);

router.get(
  '/:id/media',
  authenticateJWT,
  verifyConversationAccess,
  conversationController.getConversationMedia
);

export default router;