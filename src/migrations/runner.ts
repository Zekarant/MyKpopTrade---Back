import mongoose, { type mongo } from 'mongoose';
import logger from '../commons/utils/logger';

/**
 * Migration de données ou de schéma. `up` doit être idempotente : une
 * migration interrompue est rejouée en entier au lancement suivant.
 */
export interface Migration {
  /** Ordre d'application : préfixe numérique du fichier (ex. `0004-uniquePaymentIntentId`). */
  id: string;
  description: string;
  up(): Promise<void>;
}

/** Collection qui garde la trace des migrations appliquées. */
export const MIGRATIONS_COLLECTION = 'migrations';

interface AppliedMigration {
  _id: string;
  description: string;
  appliedAt: Date;
}

/**
 * Applique, dans l'ordre, les migrations pas encore passées sur cette base, et
 * enregistre chacune après son succès. S'arrête à la première qui échoue :
 * les suivantes peuvent dépendre d'elle.
 *
 * @returns les identifiants des migrations appliquées par cet appel
 */
export async function runMigrations(migrations: readonly Migration[]): Promise<string[]> {
  assertOrdered(migrations);

  const journal = mongoose.connection.collection<AppliedMigration>(MIGRATIONS_COLLECTION);
  const alreadyApplied = new Set((await journal.find({}, { projection: { _id: 1 } }).toArray()).map((doc) => doc._id));

  const applied: string[] = [];
  for (const migration of migrations) {
    if (alreadyApplied.has(migration.id)) continue;

    logger.info('migration.started', { id: migration.id, description: migration.description });
    await migration.up();
    if (!(await recordApplied(journal, migration))) {
      logger.info('migration.alreadyRecorded', { id: migration.id });
      continue;
    }
    logger.info('migration.applied', { id: migration.id });
    applied.push(migration.id);
  }
  return applied;
}

const DUPLICATE_KEY_ERROR = 11000;

/**
 * Inscrit la migration au journal. Deux déploiements simultanés peuvent la
 * jouer en même temps (sans risque, elle est idempotente) : le second trouve
 * l'entrée déjà écrite, ce qui n'est pas un échec.
 *
 * @returns false si un autre lancement l'avait déjà inscrite
 */
async function recordApplied(journal: mongo.Collection<AppliedMigration>, migration: Migration): Promise<boolean> {
  try {
    await journal.insertOne({ _id: migration.id, description: migration.description, appliedAt: new Date() });
    return true;
  } catch (error) {
    if ((error as { code?: unknown }).code === DUPLICATE_KEY_ERROR) return false;
    throw error;
  }
}

/** Un identifiant en double ou hors ordre appliquerait les migrations dans le désordre. */
function assertOrdered(migrations: readonly Migration[]): void {
  migrations.forEach((migration, index) => {
    const previous = migrations[index - 1];
    if (previous && previous.id >= migration.id) {
      throw new Error(`Migrations mal ordonnées : "${migration.id}" doit suivre strictement "${previous.id}"`);
    }
  });
}
