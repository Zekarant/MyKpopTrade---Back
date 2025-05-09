import express from 'express';
import * as notificationController from './controller/notificationController';
import { authenticateJWT } from '../../commons/middlewares/authMiddleware';
import { sanitizeInputs } from '../../commons/middlewares/sanitizeMiddleware';

const router = express.Router();

// Appliquer la sanitisation pour toutes les routes
router.use(sanitizeInputs);

// Toutes les routes nécessitent une authentification
router.use(authenticateJWT);

// Obtenir les notifications de l'utilisateur
router.get('/', notificationController.getMyNotifications);

// Marquer toutes les notifications comme lues
router.put('/read-all', notificationController.markAllNotificationsAsRead);

// Marquer une notification comme lue
router.put('/:id/read', notificationController.markNotificationAsRead);

// Supprimer une notification
router.delete('/:id', notificationController.deleteNotification);

export default router;