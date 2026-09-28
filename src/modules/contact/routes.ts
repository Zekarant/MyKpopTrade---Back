import { Router, Request, Response } from 'express';
import { asyncHandler } from '../../commons/middlewares/errorMiddleware';
import { mapHttpError } from '../../commons/utils/httpErrorMapper';
import { rateLimitContact } from '../auth/middleware/authRateLimiter';
import { deliverContactMessage, parseContactMessage } from './contactService';

const router = Router();

/** Formulaire de contact public : validé et relayé au support côté serveur. */
router.post('/', rateLimitContact, asyncHandler(async (req: Request, res: Response) => {
  try {
    await deliverContactMessage(parseContactMessage(req.body));
    return res.status(202).json({ message: 'Votre message a bien été envoyé.' });
  } catch (error) {
    const mapped = mapHttpError(res, error);
    if (mapped) return mapped;
    throw error;
  }
}));

export default router;
