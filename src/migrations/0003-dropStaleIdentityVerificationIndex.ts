import IdentityVerification from '../models/identityVerificationModel';
import logger from '../commons/utils/logger';
import type { Migration } from './runner';

/**
 * L'ancien index unique (user, expiresAt) a été remplacé par un index unique
 * sur (user) seul (cf. src/models/identityVerificationModel.ts). Mongoose ne
 * supprime jamais automatiquement un ancien index.
 */
export const STALE_INDEX_NAME = 'user_1_expiresAt_1';

export async function dropStaleIdentityVerificationIndex(): Promise<boolean> {
  // Sur une base neuve la collection n'existe pas encore : Mongo refuse alors
  // de lister ses index (NamespaceNotFound), et il n'y a rien à supprimer.
  const existingIndexes = await IdentityVerification.collection.indexes().catch(() => []);
  if (!existingIndexes.some((index) => index.name === STALE_INDEX_NAME)) return false;

  await IdentityVerification.collection.dropIndex(STALE_INDEX_NAME);
  return true;
}

export const migration: Migration = {
  id: '0003-dropStaleIdentityVerificationIndex',
  description: 'Supprime l\'ancien index unique (user, expiresAt) des vérifications d\'identité',
  async up() {
    logger.info('migration.dropStaleIdentityVerificationIndex', { dropped: await dropStaleIdentityVerificationIndex() });
  }
};
