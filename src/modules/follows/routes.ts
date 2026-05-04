import { Router } from 'express';
import { authenticateJWT } from '../../commons/middlewares/authMiddleware';
import * as followController from './controller';

const router = Router();

// Toggle follow/unfollow
router.post('/:targetUserId/toggle', authenticateJWT, followController.toggleFollow);

// Get follow status (am I following this user + their counts)
router.get('/:targetUserId/status', authenticateJWT, followController.getFollowStatus);

// Get followers of a user
router.get('/:userId/followers', authenticateJWT, followController.getFollowers);

// Get following of a user
router.get('/:userId/following', authenticateJWT, followController.getFollowing);

// Get mutual follows (friends)
router.get('/me/friends', authenticateJWT, followController.getFriends);

// Get my follow counts
router.get('/me/counts', authenticateJWT, followController.getMyCounts);

// Remove a follower (someone who follows me)
router.delete('/me/followers/:followerId', authenticateJWT, followController.removeFollower);

export default router;
