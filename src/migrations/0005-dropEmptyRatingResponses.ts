import Rating from '../models/ratingModel';
import logger from '../commons/utils/logger';
import type { Migration } from './runner';

/**
 * Retire les réponses vides des avis. `response.createdAt` avait une valeur
 * par défaut : chaque avis était enregistré avec `response: { createdAt }`,
 * même sans réponse du destinataire.
 *
 * Passe par le driver : à travers Mongoose, la valeur par défaut serait
 * réappliquée au chargement.
 */
export async function dropEmptyRatingResponses(): Promise<number> {
  const result = await Rating.collection.updateMany(
    { response: { $exists: true }, 'response.content': { $exists: false } },
    { $unset: { response: '' } }
  );
  return result.modifiedCount;
}

export const migration: Migration = {
  id: '0005-dropEmptyRatingResponses',
  description: 'Retire les réponses vides enregistrées sur les avis',
  async up() {
    logger.info('migration.dropEmptyRatingResponses', { ratings: await dropEmptyRatingResponses() });
  }
};
