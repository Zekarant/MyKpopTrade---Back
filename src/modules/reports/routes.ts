import { Router } from 'express';
import * as reportController from './controllers/reportController';
import { authenticateJWT, requireAdmin } from '../../commons/middlewares/authMiddleware';
import { rateLimitReports } from '../auth/middleware/authRateLimiter';

const router = Router();

router.post('/', authenticateJWT, rateLimitReports, reportController.createReport);
router.get('/me', authenticateJWT, reportController.getUserReports);
router.get('/check/:targetType/:targetId', authenticateJWT, reportController.checkUserReport);
router.get('/', authenticateJWT, requireAdmin, reportController.getAllReports);
router.put('/bulk', authenticateJWT, requireAdmin, reportController.bulkUpdateReportStatus);
router.get('/:reportId', authenticateJWT, requireAdmin, reportController.getReportDetail);
router.put('/:reportId', authenticateJWT, requireAdmin, reportController.updateReportStatus);

export default router;