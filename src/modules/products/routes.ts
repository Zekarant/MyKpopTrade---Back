import { Router } from 'express';
import * as productController from './controllers/productController';
import * as inventoryController from './controllers/inventoryController';
import { authenticateJWT } from '../../commons/middlewares/authMiddleware';

const router = Router();

// Routes de produits - création et mise à jour (protégées)
router.post('/', authenticateJWT, productController.createProduct);
router.put('/:productId', authenticateJWT, productController.updateProduct);
router.delete('/:productId', authenticateJWT, productController.deleteProduct);
router.post('/:productId/sold', authenticateJWT, productController.markProductAsSold);
router.post('/:productId/favorite', authenticateJWT, productController.toggleFavorite);

// Routes de produits - consultation (publiques)
router.get('/', productController.getProducts);
router.get('/:productId', productController.getProductById);

// Routes d'inventaire
router.get('/inventory/me', authenticateJWT, inventoryController.getUserInventory);
router.get('/inventory/user/:userId', inventoryController.getUserInventory);
router.get('/inventory/favorites', authenticateJWT, inventoryController.getUserFavorites);
router.get('/recommendations/:productId?', inventoryController.getRecommendedProducts);
router.get('/stats', inventoryController.getProductStats);

export default router;