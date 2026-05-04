import { Router } from 'express';
import * as productController from './controllers/productController';
import * as inventoryController from './controllers/inventoryController';
import { authenticateJWT, requireAdmin } from '../../commons/middlewares/authMiddleware';
import * as productImageController from './controllers/productImageController';
import { productImagesUpload } from '../profiles/middleware/fileUploaderMiddleware';
import * as productAdminController from './controllers/productAdminController';

const router = Router();

router.get('/recommendations', authenticateJWT, inventoryController.getRecommendedProducts);
router.get('/quick-recommendations', inventoryController.getQuickRecommendations);
router.get('/stats', inventoryController.getProductStats);

router.get('/inventory/me', authenticateJWT, inventoryController.getUserInventory);
router.get('/inventory/user/:userId', inventoryController.getUserInventory);
router.get('/inventory/favorites', authenticateJWT, inventoryController.getUserFavorites);

router.post('/', 
  authenticateJWT, 
  productImagesUpload.array('productImages', 10), 
  productController.createProduct
);
router.put('/:productId', authenticateJWT, productController.updateProduct);
router.delete('/:productId', authenticateJWT, productController.deleteProduct);
router.post('/:productId/sold', authenticateJWT, productController.markProductAsSold);
router.post('/:productId/favorite', authenticateJWT, productController.toggleFavorite);

router.post(
  '/:productId/images',
  authenticateJWT,
  productImagesUpload.single('productImage'),
  productImageController.uploadProductImage
);

router.delete(
  '/:productId/images',
  authenticateJWT,
  productImageController.deleteProductImage
);

router.put(
  '/:productId/images/reorder',
  authenticateJWT,
  productImageController.reorderProductImages
);

router.get('/', productController.getProducts);

// Admin routes (MUST be before /:productId to avoid matching 'admin' as productId)
router.get('/admin/list', authenticateJWT, requireAdmin, productAdminController.getAllProducts);
router.get('/admin/stats', authenticateJWT, requireAdmin, productAdminController.getProductAdminStats);
router.delete('/admin/:productId', authenticateJWT, requireAdmin, productAdminController.adminDeleteProduct);

router.get('/:productId', authenticateJWT, productController.getProductById);

export default router;