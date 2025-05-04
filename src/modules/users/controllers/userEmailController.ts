import { Request, Response } from 'express';
import UserEmail from '../../../models/UserEmail';

export const addEmail = async (req: Request, res: Response): Promise<void> => {
    const { email } = req.body;

    try {
        // Vérifiez si l'email existe déjà
        const existingEmail = await UserEmail.findOne({ email });
        if (existingEmail) {
            res.status(400).json({ message: 'Email déjà enregistré' });
            return;
        }

        const userEmail = new UserEmail({ email });
        await userEmail.save();
        res.status(201).json(userEmail);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Erreur serveur' });
    }
};