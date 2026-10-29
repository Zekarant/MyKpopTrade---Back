import mongoose from 'mongoose';
import logger from '../commons/utils/logger';
import { decodeHtmlEntities } from '../commons/utils/plainText';
import { MIGRATIONS_COLLECTION, type Migration } from './runner';

/**
 * Décode les entités HTML des textes déjà enregistrés. Le nettoyage des saisies
 * stockait la sortie HTML de DOMPurify (« A&B » → « A&amp;B »), affichée telle
 * quelle par le front ; il stocke désormais du texte brut (commons/utils/plainText).
 *
 * Toutes les collections sont parcourues, chaînes imbriquées comprises : seuls
 * les champs qui contiennent une entité sont réécrits, par lots. Rejouée (après
 * un échec en cours de route, les collections déjà traitées le sont de nouveau),
 * elle ne change plus rien, sauf un texte où un membre avait tapé lui-même une
 * entité (« &lt; »), qui passerait de « &lt; » à « < » : cas marginal, accepté.
 */

const BATCH_SIZE = 500;

/** Ajoute à `out` le chemin (`a.b.0.c`) et la valeur décodée de chaque chaîne qui change. */
function collectDecoded(value: unknown, path: string, out: Record<string, string>): void {
  if (typeof value === 'string') {
    const decoded = decodeHtmlEntities(value);
    if (decoded !== value) out[path] = decoded;
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => collectDecoded(item, `${path}.${index}`, out));
  } else if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    // Objets simples seulement : ObjectId, Date et binaires n'ont pas de texte.
    for (const [key, child] of Object.entries(value)) collectDecoded(child, `${path}.${key}`, out);
  }
}

/** @returns le nombre de documents réécrits */
export async function decodeStoredHtmlEntities(): Promise<number> {
  const db = mongoose.connection.db;
  if (!db) throw new Error('Base non connectée');

  let modified = 0;
  for (const collection of await db.collections()) {
    if (collection.collectionName === MIGRATIONS_COLLECTION || collection.collectionName.startsWith('system.')) continue;

    const updates: mongoose.mongo.AnyBulkWriteOperation[] = [];
    for await (const doc of collection.find({})) {
      const $set: Record<string, string> = {};
      for (const [key, value] of Object.entries(doc)) {
        if (key !== '_id') collectDecoded(value, key, $set);
      }
      if (Object.keys($set).length > 0) updates.push({ updateOne: { filter: { _id: doc._id }, update: { $set } } });
      if (updates.length >= BATCH_SIZE) {
        modified += (await collection.bulkWrite(updates.splice(0))).modifiedCount;
      }
    }
    if (updates.length > 0) modified += (await collection.bulkWrite(updates)).modifiedCount;
  }
  return modified;
}

export const migration: Migration = {
  id: '0006-decodeStoredHtmlEntities',
  description: 'Décode les entités HTML stockées par l\'ancien nettoyage des saisies',
  async up() {
    logger.info('migration.decodeStoredHtmlEntities', { documents: await decodeStoredHtmlEntities() });
  }
};
