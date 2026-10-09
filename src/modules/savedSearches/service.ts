import mongoose from 'mongoose';
import SavedSearch, { ISavedSearch } from './model';
import { HttpError } from '../../commons/utils/httpError';
import { toGroupKeys } from './matcher';
import type { SavedSearchCreateInput, SavedSearchUpdateInput } from './validation';

/** Au-delà, les alertes deviendraient du bruit : l'utilisateur fait le tri. */
export const MAX_SAVED_SEARCHES_PER_USER = 20;

/** Champs exposés au client ; les champs internes d'alerte restent côté serveur. */
const PUBLIC_FIELDS = '_id name criteria alertsEnabled lastNotifiedAt createdAt';

export type PublicSavedSearch = Pick<ISavedSearch, 'name' | 'criteria' | 'alertsEnabled' | 'lastNotifiedAt' | 'createdAt'> & {
  _id: mongoose.Types.ObjectId;
};

const notFound = () => new HttpError(404, 'Recherche sauvegardée introuvable', 'SAVED_SEARCH_NOT_FOUND');

/** Un identifiant invalide ou appartenant à un autre membre répond pareil : 404. */
function assertValidId(savedSearchId: string) {
  if (!mongoose.Types.ObjectId.isValid(savedSearchId)) throw notFound();
}

/** Liste bornée par MAX_SAVED_SEARCHES_PER_USER : pas besoin de pagination. */
export async function listSavedSearches(userId: string): Promise<PublicSavedSearch[]> {
  return SavedSearch.find({ user: userId })
    .select(PUBLIC_FIELDS)
    .sort({ createdAt: -1 })
    .limit(MAX_SAVED_SEARCHES_PER_USER)
    .lean<PublicSavedSearch[]>();
}

export async function createSavedSearch(userId: string, input: SavedSearchCreateInput): Promise<PublicSavedSearch> {
  const count = await SavedSearch.countDocuments({ user: userId });
  if (count >= MAX_SAVED_SEARCHES_PER_USER) {
    throw new HttpError(
      409,
      `Vous avez atteint la limite de ${MAX_SAVED_SEARCHES_PER_USER} recherches sauvegardées. Supprimez-en une pour en ajouter une nouvelle.`,
      'SAVED_SEARCH_LIMIT_REACHED'
    );
  }

  const created = await SavedSearch.create({
    user: userId,
    name: input.name,
    criteria: input.criteria,
    alertsEnabled: input.alertsEnabled ?? true,
    groupKeys: toGroupKeys(input.criteria)
  });

  return {
    _id: created._id,
    name: created.name,
    criteria: created.criteria,
    alertsEnabled: created.alertsEnabled,
    lastNotifiedAt: created.lastNotifiedAt,
    createdAt: created.createdAt
  };
}

export async function updateSavedSearch(
  userId: string,
  savedSearchId: string,
  changes: SavedSearchUpdateInput
): Promise<PublicSavedSearch> {
  assertValidId(savedSearchId);

  // Couper les alertes abandonne aussi les annonces en attente : sinon elles
  // partiraient d'un coup à la réactivation, parfois des jours plus tard.
  const update = changes.alertsEnabled === false
    ? { $set: { ...changes, pendingProductIds: [] }, $unset: { pendingSince: 1 } }
    : { $set: changes };

  const updated = await SavedSearch.findOneAndUpdate({ _id: savedSearchId, user: userId }, update, {
    returnDocument: 'after',
    projection: PUBLIC_FIELDS
  }).lean<PublicSavedSearch>();

  if (!updated) throw notFound();
  return updated;
}

export async function deleteSavedSearch(userId: string, savedSearchId: string): Promise<void> {
  assertValidId(savedSearchId);
  const { deletedCount } = await SavedSearch.deleteOne({ _id: savedSearchId, user: userId });
  if (deletedCount === 0) throw notFound();
}
