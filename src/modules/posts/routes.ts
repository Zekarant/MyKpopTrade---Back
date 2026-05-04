import { Router } from 'express';
import * as postController from './controller';
import { authenticateJWT } from '../../commons/middlewares/authMiddleware';
import { productImagesUpload } from '../profiles/middleware/fileUploaderMiddleware';

const router = Router();

// Feed (posts des utilisateurs suivis)
router.get('/feed', authenticateJWT, postController.getFeed);

// Posts d'un utilisateur
router.get('/user/:userId', postController.getUserPosts);

// CRUD
router.post('/', authenticateJWT, productImagesUpload.array('postImages', 4), postController.createPost);
router.get('/:postId', postController.getPost);
router.delete('/:postId', authenticateJWT, postController.deletePost);

// Interactions
router.post('/:postId/reply', authenticateJWT, postController.replyToPost);
router.post('/:postId/like', authenticateJWT, postController.toggleLike);

export default router;
