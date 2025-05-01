import { Router } from 'express';
import { addEmail } from './controllers/userEmailController';

const router = Router();

router.post('/add-email', addEmail);

export default router;