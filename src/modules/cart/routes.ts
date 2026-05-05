import express from 'express';
import * as cartController from './controllers/cartController';
import * as cartCheckoutController from './controllers/cartCheckoutController';
import { authenticateJWT } from '../../commons/middlewares/authMiddleware';
import { sanitizeInputs } from '../../commons/middlewares/sanitizeMiddleware';
import { rateLimitCartAdd, rateLimitCheckout } from './middleware/cartRateLimiter';

const router = express.Router();

router.use(sanitizeInputs);
router.use(authenticateJWT);

router.get('/', cartController.getCart);
router.post('/items', rateLimitCartAdd, cartController.addItem);
router.delete('/items/:productId', rateLimitCartAdd, cartController.removeItem);
router.delete('/', cartController.clearCart);
router.post('/validate', cartController.validateCart);
router.post('/checkout', rateLimitCheckout, cartCheckoutController.checkoutCart);
router.post('/finalize', cartCheckoutController.finalizeCheckout);

export default router;
