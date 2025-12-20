import { Request, Response } from 'express';
import User from '../../../models/userModel';
import { asyncHandler } from '../../../commons/middlewares/errorMiddleware';

/**
 * Recherche d'utilisateurs par nom partiel (insensible à la casse)
 * @route GET /users/search?query=xxx
 */
export const searchUsers = asyncHandler(async (req: Request, res: Response) => {
    const { query } = req.query;
    if (!query || typeof query !== 'string' || query.length < 2) {
        return res.status(400).json({ message: 'Veuillez fournir au moins 2 caractères pour la recherche.' });
    }
    // Recherche insensible à la casse
    const users = await User.find({
        username: { $regex: query, $options: 'i' }
    }).select('username profilePicture email location bio');
    res.json({ users });
});
