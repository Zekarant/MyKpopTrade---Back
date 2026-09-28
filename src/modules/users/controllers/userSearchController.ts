import { Request, Response } from 'express';
import User from '../../../models/userModel';
import { asyncHandler } from '../../../commons/middlewares/errorMiddleware';
import { escapeRegex } from '../../../commons/utils/escapeRegex';

const USER_SEARCH_MAX_RESULTS = 20;

/**
 * Recherche d'utilisateurs par nom partiel (insensible à la casse)
 * @route GET /users/search?query=xxx
 */
export const searchUsers = asyncHandler(async (req: Request, res: Response) => {
    const { query } = req.query;
    if (!query || typeof query !== 'string' || query.length < 2) {
        return res.status(400).json({ message: 'Veuillez fournir au moins 2 caractères pour la recherche.' });
    }
    // Route publique : jamais d'email dans la réponse, résultats bornés.
    const users = await User.find({
        username: { $regex: escapeRegex(query), $options: 'i' }
    })
        .select('username profilePicture location bio')
        .limit(USER_SEARCH_MAX_RESULTS);
    res.json({ users });
});
