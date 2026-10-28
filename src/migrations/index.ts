import type { Migration } from './runner';
import { migration as dropLegacyFields } from './0001-dropLegacyFields';
import { migration as backfillManualSales } from './0002-backfillManualSales';
import { migration as dropStaleIdentityVerificationIndex } from './0003-dropStaleIdentityVerificationIndex';
import { migration as uniquePaymentIntentId } from './0004-uniquePaymentIntentId';
import { migration as dropEmptyRatingResponses } from './0005-dropEmptyRatingResponses';

/**
 * Toutes les migrations, dans l'ordre d'application. Une nouvelle migration
 * s'ajoute en fin de liste, avec le numéro suivant ; une migration déjà
 * appliquée en production ne se modifie plus (en écrire une nouvelle).
 */
export const migrations: readonly Migration[] = [
  dropLegacyFields,
  backfillManualSales,
  dropStaleIdentityVerificationIndex,
  uniquePaymentIntentId,
  dropEmptyRatingResponses
];
