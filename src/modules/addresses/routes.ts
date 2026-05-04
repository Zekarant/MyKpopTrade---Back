import express from 'express';
import { authenticateJWT } from '../../commons/middlewares/authMiddleware';
import { sanitizeInputs } from '../../commons/middlewares/sanitizeMiddleware';
import { addressLookup } from './controllers/addressController';

const router = express.Router();

router.use(sanitizeInputs);
router.use(authenticateJWT);

router.get('/lookup', addressLookup);

export default router;
