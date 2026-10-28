import User from '../../../models/userModel';
import { escapeRegex } from '../../../commons/utils/escapeRegex';

const USER_SEARCH_MAX_RESULTS = 20;

/**
 * Recherche publique de membres par pseudo partiel (insensible à la casse).
 * Jamais d'email dans le résultat, nombre de résultats borné.
 */
export async function searchPublicUsers(term: string) {
  return User.find({ username: { $regex: escapeRegex(term), $options: 'i' } })
    .select('username profilePicture location bio')
    .limit(USER_SEARCH_MAX_RESULTS)
    .lean();
}
