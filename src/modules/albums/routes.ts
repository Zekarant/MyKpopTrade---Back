import { Router } from 'express';
import * as albumController from './controllers/albumsController';
import { authenticateJWT, requireAdmin } from '../../commons/middlewares/authMiddleware';

const router = Router();

// Routes publiques
router.get('/', albumController.getAlbums);
router.get('/search', albumController.searchAlbums);
router.get('/:albumId', albumController.getAlbumById);
router.get('/group/:groupId', albumController.getAlbumsByGroup);

// Routes administrateur
router.post('/', authenticateJWT, requireAdmin, albumController.createAlbum);
router.put('/:albumId', authenticateJWT, requireAdmin, albumController.updateAlbum);
router.delete('/:albumId', authenticateJWT, requireAdmin, albumController.deleteAlbum);

export default router;