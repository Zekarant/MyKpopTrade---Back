import { Router } from 'express';
import { addEmail } from '../controllers/UserEmailController';

const router = Router();

router.post('/add-email', addEmail);

export default router;