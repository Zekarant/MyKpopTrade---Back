import express from 'express';
import { authenticateJWT } from '../../commons/middlewares/authMiddleware';
import { streamEvents } from './controllers/realtimeController';

const router = express.Router();

router.get('/stream', authenticateJWT, streamEvents);

export default router;
