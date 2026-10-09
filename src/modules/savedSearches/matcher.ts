import type { IProduct } from '../../models/productModel';
import type { SavedSearchCriteria } from './validation';
import { ANY_GROUP_KEY } from './model';

export type MatchableProduct = Pick<
  IProduct,
  | 'title' | 'description' | 'price' | 'currency' | 'condition' | 'type'
  | 'kpopGroup' | 'kpopMember' | 'albumName'
  | 'member' | 'version' | 'isOfficial'
>;

/**
 * Identifiants du catalogue qu'une annonce satisfait, résolus une fois par
 * annonce (cf. alertService) : son `group` / `album` structuré, et pour les
 * anciennes annonces l'identifiant ou le nom stocké dans `kpopGroup` / `albumName`.
 */
export interface ProductCatalogIds {
  groupIds: string[];
  albumIds: string[];
}

/** Préfixe des clés indexées d'un groupe du catalogue, distinctes des noms libres. */
const CATALOG_GROUP_KEY_PREFIX = 'group:';

const normalize = (value: string | undefined | null): string => (value ?? '').trim().toLowerCase();

/**
 * Clés indexées d'une recherche, toutes nécessaires à une correspondance :
 * le groupe du catalogue s'il y en a un, sinon ses groupes par nom, sinon
 * « tous groupes ».
 */
export function toGroupKeys(criteria: Pick<SavedSearchCriteria, 'group' | 'groups'>): string[] {
  if (criteria.group) return [`${CATALOG_GROUP_KEY_PREFIX}${criteria.group}`];
  return criteria.groups?.length ? [...new Set(criteria.groups.map(normalize))] : [ANY_GROUP_KEY];
}

/** Clés de groupe qu'une annonce peut satisfaire. */
export function groupKeysForProduct(product: Pick<IProduct, 'kpopGroup'>, catalogIds: ProductCatalogIds): string[] {
  return [
    ANY_GROUP_KEY,
    normalize(product.kpopGroup),
    ...catalogIds.groupIds.map((id) => `${CATALOG_GROUP_KEY_PREFIX}${id}`)
  ];
}

const equalsAny = (candidates: string[] | undefined, value: string | undefined): boolean =>
  !candidates?.length || candidates.some((candidate) => normalize(candidate) === normalize(value));

/** Même sémantique que `buildCatalogClauses` (productCatalogService), repli legacy compris. */
function matchesCatalogCriteria(
  criteria: SavedSearchCriteria,
  product: MatchableProduct,
  catalogIds: ProductCatalogIds
): boolean {
  if (criteria.group && !catalogIds.groupIds.includes(criteria.group)) return false;
  if (criteria.member && product.member !== criteria.member && product.kpopMember !== criteria.member) return false;
  if (criteria.album && !catalogIds.albumIds.includes(criteria.album)) return false;
  if (criteria.version && product.version !== criteria.version) return false;
  if (criteria.isOfficial !== undefined && product.isOfficial !== criteria.isOfficial) return false;
  return true;
}

/**
 * Même sémantique que `buildProductFilters` (searchService) : texte cherché
 * sans casse dans le titre, la description et les champs K-pop ; groupes,
 * membres et albums égaux sans casse ; fourchette de prix bornes incluses.
 * Les critères du catalogue suivent `buildCatalogClauses`. Une alerte doit
 * annoncer exactement ce que « Lancer » affichera.
 */
export function matchesCriteria(
  criteria: SavedSearchCriteria,
  product: MatchableProduct,
  catalogIds: ProductCatalogIds
): boolean {
  const query = normalize(criteria.query);
  if (query) {
    const searchable = [product.title, product.description, product.kpopGroup, product.kpopMember, product.albumName];
    if (!searchable.some((field) => normalize(field).includes(query))) return false;
  }

  if (!equalsAny(criteria.groups, product.kpopGroup)) return false;
  if (!equalsAny(criteria.members, product.kpopMember)) return false;
  if (!equalsAny(criteria.albums, product.albumName)) return false;

  if (criteria.type && criteria.type !== product.type) return false;
  if (criteria.condition?.length && !criteria.condition.includes(product.condition)) return false;
  if (criteria.currency && criteria.currency !== product.currency) return false;

  const { min, max } = criteria.priceRange ?? {};
  if (min !== undefined && product.price < min) return false;
  if (max !== undefined && product.price > max) return false;

  return matchesCatalogCriteria(criteria, product, catalogIds);
}
