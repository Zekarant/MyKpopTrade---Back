import { Router } from 'express';
import * as groupController from './controllers/kpopGroupsController';
import * as followController from './controllers/groupFollowController';
import { authenticateJWT, requireAdmin } from '../../commons/middlewares/authMiddleware';

const router = Router();

router.get('/', groupController.getKpopGroups);
router.get('/popular', groupController.getPopularGroups);
router.get('/search', groupController.searchGroups);

router.get('/my-followed', authenticateJWT, followController.getUserFollowedGroups);

router.get('/:groupId', groupController.getKpopGroupById);
router.get('/:groupId/followers', followController.getGroupFollowers);
router.get('/:groupId/follow-status', authenticateJWT, followController.getFollowStatus);
router.post('/:groupId/follow', authenticateJWT, followController.toggleFollowGroup);

router.post('/', authenticateJWT, requireAdmin, groupController.createKpopGroup);
router.put('/:groupId', authenticateJWT, requireAdmin, groupController.updateKpopGroup);
router.delete('/:groupId', authenticateJWT, requireAdmin, groupController.deleteKpopGroup);

export default router;