import { Router } from 'express';
import { authenticateJWT } from '../../commons/middlewares/authMiddleware';
import * as savedSearchController from './controller';

const router = Router();

router.get('/', authenticateJWT, savedSearchController.getSavedSearches);
router.post('/', authenticateJWT, savedSearchController.postSavedSearch);
router.patch('/:id', authenticateJWT, savedSearchController.patchSavedSearch);
router.delete('/:id', authenticateJWT, savedSearchController.removeSavedSearch);

export default router;
