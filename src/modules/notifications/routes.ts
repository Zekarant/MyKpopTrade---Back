import express from 'express';
import * as notificationController from './controller/notificationController';
import * as pushController from './controller/pushController';
import { authenticateJWT } from '../../commons/middlewares/authMiddleware';
import { sanitizeInputs } from '../../commons/middlewares/sanitizeMiddleware';

const router = express.Router();

// Appliquer la sanitisation pour toutes les routes
router.use(sanitizeInputs);

// Clé VAPID publique : nécessaire côté navigateur AVANT l'auth pour
// permettre au service worker de souscrire dès le premier consentement.
router.get('/push/vapid-public-key', pushController.getVapidPublicKey);

// Toutes les routes ci-dessous nécessitent une authentification
router.use(authenticateJWT);

// Obtenir les notifications de l'utilisateur
router.get('/', notificationController.getMyNotifications);

// Marquer toutes les notifications comme lues
router.put('/read-all', notificationController.markAllNotificationsAsRead);

// Marquer une notification comme lue
router.put('/:id/read', notificationController.markNotificationAsRead);

// Supprimer une notification
router.delete('/:id', notificationController.deleteNotification);

// Web push : souscription / désinscription
router.post('/push/subscribe', pushController.subscribeToPush);
router.post('/push/unsubscribe', pushController.unsubscribeFromPush);

export default router;