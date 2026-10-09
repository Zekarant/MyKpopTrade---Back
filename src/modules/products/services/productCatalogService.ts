import mongoose from 'mongoose';
import { IProduct } from '../../../models/productModel';
import KpopGroup from '../../../models/kpopGroupModel';
import KpopAlbum from '../../../models/albumModel';
import { HttpError } from '../../../commons/utils/httpError';

/**
 * Métadonnées structurées d'une annonce (groupe, membre, album, version,
 * officielle) : cohérence avec le catalogue à l'écriture, filtres à la lecture.
 */

const MAX_MEMBER_LENGTH = 100;
const MAX_VERSION_LENGTH = 50;

type ProductFilter = mongoose.QueryFilter<IProduct>;

export interface CatalogReferences {
  group?: string | null;
  member?: string | null;
  album?: string | null;
}

/**
 * Le groupe et l'album doivent exister, l'album appartenir au groupe, et le
 * membre figurer dans la liste du groupe quand celui-ci en a une.
 *
 * @throws HttpError 400 sur la première incohérence.
 */
export async function assertCatalogConsistency({ group, member, album }: CatalogReferences): Promise<void> {
  const [groupDoc, albumDoc] = await Promise.all([
    group ? KpopGroup.findById(group).select('members').lean() : null,
    album ? KpopAlbum.findById(album).select('artistId').lean() : null
  ]);

  if (group && !groupDoc) throw new HttpError(400, 'Groupe introuvable');
  if (album && !albumDoc) throw new HttpError(400, 'Album introuvable');

  // Beaucoup de groupes du catalogue n'ont pas encore de membres saisis : la
  // saisie libre reste alors permise plutôt que de bloquer la mise en vente.
  if (member && groupDoc?.members?.length && !groupDoc.members.includes(member)) {
    throw new HttpError(400, 'Ce membre ne fait pas partie du groupe choisi');
  }
  if (groupDoc && albumDoc && String(albumDoc.artistId) !== String(groupDoc._id)) {
    throw new HttpError(400, 'Cet album n\'appartient pas au groupe choisi');
  }
}

/** Critères de catalogue acceptés par la liste et la recherche (allowlist). */
export interface CatalogCriteria {
  group?: string;
  member?: string;
  album?: string;
  version?: string;
  isOfficial?: boolean;
}

function readObjectId(value: unknown, message: string): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !mongoose.Types.ObjectId.isValid(value)) {
    throw new HttpError(400, message);
  }
  return value;
}

function readText(value: unknown, label: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length > maxLength) {
    throw new HttpError(400, `${label} invalide (texte de ${maxLength} caractères maximum)`);
  }
  return value.trim() || undefined;
}

/** Accepte le booléen JSON comme le texte de la query (`?isOfficial=true`). */
function readBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined || value === '') return undefined;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new HttpError(400, `${label} doit valoir true ou false`);
}

/**
 * Extrait les critères de catalogue d'une query ou d'un corps de requête.
 *
 * @throws HttpError 400 si un critère est mal formé.
 */
export function parseCatalogCriteria(source: Record<string, unknown>): CatalogCriteria {
  return {
    group: readObjectId(source.group, 'Identifiant de groupe invalide'),
    member: readText(source.member, 'Membre', MAX_MEMBER_LENGTH),
    album: readObjectId(source.album, 'Identifiant d\'album invalide'),
    version: readText(source.version, 'Version', MAX_VERSION_LENGTH),
    isOfficial: readBoolean(source.isOfficial, 'isOfficial')
  };
}

/**
 * Clauses Mongo (à combiner en `$and`) des critères de catalogue.
 *
 * Groupe, membre et album retrouvent aussi les annonces antérieures aux champs
 * structurés : leur `kpopGroup` / `albumName` contient l'identifiant ou le nom
 * exact, et le membre n'est que dans `kpopMember`.
 */
export async function buildCatalogClauses(criteria: CatalogCriteria): Promise<ProductFilter[]> {
  const { group, member, album, version, isOfficial } = criteria;
  const [groupDoc, albumDoc] = await Promise.all([
    group ? KpopGroup.findById(group).select('name').lean() : null,
    album ? KpopAlbum.findById(album).select('name').lean() : null
  ]);

  const clauses: ProductFilter[] = [];
  if (group) {
    const legacyKeys = groupDoc ? [group, groupDoc.name] : [group];
    clauses.push({ $or: [{ group }, { kpopGroup: { $in: legacyKeys } }] });
  }
  if (member) {
    clauses.push({ $or: [{ member }, { kpopMember: member }] });
  }
  if (album) {
    const legacyKeys = albumDoc ? [album, albumDoc.name] : [album];
    clauses.push({ $or: [{ album }, { albumName: { $in: legacyKeys } }] });
  }
  if (version) clauses.push({ version });
  if (isOfficial !== undefined) clauses.push({ isOfficial });
  return clauses;
}
