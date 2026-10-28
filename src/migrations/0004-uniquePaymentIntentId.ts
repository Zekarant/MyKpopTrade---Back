import Payment from '../models/paymentModel';
import type { Migration } from './runner';

/**
 * Un ordre PayPal (`paymentIntentId`) ne correspond qu'à un paiement : capture,
 * annulation et webhooks retrouvent le paiement par `findOne` sur ce champ, et
 * un doublon ferait traiter le mauvais document. L'index devient unique (sur
 * les seuls documents qui portent l'identifiant).
 *
 * Mongoose ne remplace pas un index existant dont les options changent :
 * l'ancien index simple est supprimé ici avant de créer le nouveau.
 */
export const PAYMENT_INTENT_INDEX_NAME = 'paymentIntentId_1';

export const PAYMENT_INTENT_INDEX_OPTIONS = {
  name: PAYMENT_INTENT_INDEX_NAME,
  unique: true,
  partialFilterExpression: { paymentIntentId: { $type: 'string' } }
} as const;

/**
 * Identifiants d'ordre portés par plusieurs paiements. Ils bloquent la
 * création de l'index : à régler à la main, aucun doublon n'étant supprimable
 * sans savoir lequel est le bon.
 */
export async function findDuplicatePaymentIntentIds(): Promise<string[]> {
  const duplicates = await Payment.aggregate<{ _id: string }>([
    { $match: { paymentIntentId: { $type: 'string' } } },
    { $group: { _id: '$paymentIntentId', count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } }
  ]);
  return duplicates.map((duplicate) => duplicate._id);
}

export async function makePaymentIntentIdUnique(): Promise<void> {
  const duplicates = await findDuplicatePaymentIntentIds();
  if (duplicates.length > 0) {
    throw new Error(
      `Index unique paymentIntentId impossible : ${duplicates.length} ordre(s) PayPal portés par plusieurs paiements (${duplicates.join(', ')}). Les dédoublonner puis relancer la migration.`
    );
  }

  // Base neuve : la collection n'existe pas encore, il n'y a aucun index à remplacer.
  const indexes = await Payment.collection.indexes().catch(() => []);
  const current = indexes.find((index) => index.name === PAYMENT_INTENT_INDEX_NAME);
  const isAlreadyTarget = current?.unique === true
    && JSON.stringify(current.partialFilterExpression) === JSON.stringify(PAYMENT_INTENT_INDEX_OPTIONS.partialFilterExpression);
  if (isAlreadyTarget) return;
  if (current) await Payment.collection.dropIndex(PAYMENT_INTENT_INDEX_NAME);

  await Payment.collection.createIndex({ paymentIntentId: 1 }, PAYMENT_INTENT_INDEX_OPTIONS);
}

export const migration: Migration = {
  id: '0004-uniquePaymentIntentId',
  description: 'Rend unique l\'index des paiements sur l\'ordre PayPal',
  up: makePaymentIntentIdUnique
};
