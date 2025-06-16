import { Router } from 'express';
import * as reportController from './controllers/reportController';
import { authenticateJWT, requireAdmin } from '../../commons/middlewares/authMiddleware';

const router = Router();

router.post('/', authenticateJWT, reportController.createReport);
router.get('/me', authenticateJWT, reportController.getUserReports);
router.get('/check/:targetType/:targetId', authenticateJWT, reportController.checkUserReport);
router.get('/', authenticateJWT, requireAdmin, reportController.getAllReports);
router.put('/:reportId', authenticateJWT, requireAdmin, reportController.updateReportStatus);

export default router;