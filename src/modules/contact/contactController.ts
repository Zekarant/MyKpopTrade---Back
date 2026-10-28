import { Request, Response } from 'express';
import { deliverContactMessage, parseContactMessage } from './contactService';

/**
 * Transmet au support un message du formulaire de contact.
 * @route POST /api/contact
 * @access Public (limité en débit)
 */
export const submitContactMessage = async (req: Request, res: Response) => {
  await deliverContactMessage(parseContactMessage(req.body));
  res.status(202).json({ message: 'Votre message a bien été envoyé.' });
};
