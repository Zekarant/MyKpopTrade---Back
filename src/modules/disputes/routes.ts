import express from 'express';
import * as disputeController from './controllers/disputeController';
import { authenticateJWT, requireAdmin } from '../../commons/middlewares/authMiddleware';
import { sanitizeInputs } from '../../commons/middlewares/sanitizeMiddleware';

const router = express.Router();

router.use(sanitizeInputs);
router.use(authenticateJWT);

// Routes utilisateur
router.post('/', disputeController.create);
router.get('/me', disputeController.listMine);
router.get('/:id', disputeController.getOne);
router.post('/:id/messages', disputeController.addMessage);
router.post('/:id/cancel', disputeController.cancel);

// Routes administrateur (montées avant /:id pour les routes spécifiques)
router.get('/', requireAdmin, disputeController.adminList);
router.post('/:id/take', requireAdmin, disputeController.adminTake);
router.post('/:id/resolve', requireAdmin, disputeController.adminResolve);

export default router;
