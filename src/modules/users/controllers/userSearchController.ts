import { Request, Response } from 'express';
import { badRequest } from '../../../commons/utils/httpError';
import { queryString } from '../../../commons/utils/query';
import { searchPublicUsers } from '../services/userSearchService';

const USER_SEARCH_MIN_LENGTH = 2;

/**
 * Recherche d'utilisateurs par nom partiel (insensible à la casse)
 * @route GET /api/users/search?query=xxx
 */
export const searchUsers = async (req: Request, res: Response) => {
  const query = queryString(req.query.query);
  if (!query || query.length < USER_SEARCH_MIN_LENGTH) {
    throw badRequest(`Veuillez fournir au moins ${USER_SEARCH_MIN_LENGTH} caractères pour la recherche.`);
  }
  return res.status(200).json({ users: await searchPublicUsers(query) });
};
