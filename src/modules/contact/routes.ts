import { Router } from 'express';
import { rateLimitContact } from '../auth/middleware/authRateLimiter';
import { submitContactMessage } from './contactController';

const router = Router();

router.post('/', rateLimitContact, submitContactMessage);

export default router;
