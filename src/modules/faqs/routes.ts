import { Router } from 'express';
import * as faqController from './controller';
import { authenticateJWT, requireAdmin } from '../../commons/middlewares/authMiddleware';

const router = Router();

// Public
router.get('/', faqController.getFaqs);

// Admin
router.get('/admin/list', authenticateJWT, requireAdmin, faqController.getAllFaqs);
router.post('/admin', authenticateJWT, requireAdmin, faqController.createFaq);
router.put('/admin/:faqId', authenticateJWT, requireAdmin, faqController.updateFaq);
router.delete('/admin/:faqId', authenticateJWT, requireAdmin, faqController.deleteFaq);

export default router;
