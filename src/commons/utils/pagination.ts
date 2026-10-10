import { queryInt } from './query';

/** Plafond par défaut d'une page de liste ; les catalogues ont leur propre plafond. */
export const MAX_PAGE_SIZE = 100;

/** Borne un `limit` de pagination fourni par le client à [1, maxLimit]. */
export function clampLimit(raw: unknown, defaultLimit: number, maxLimit: number): number {
  const parsed = parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return defaultLimit;
  return Math.min(parsed, maxLimit);
}

export interface PageRequest {
  page: number;
  limit: number;
  skip: number;
}

/**
 * Lit `page` et `limit` dans la query : page ≥ 1, limit borné. Un paramètre
 * répété ou invalide retombe sur la valeur par défaut.
 */
export function parsePagination(
  query: { page?: unknown; limit?: unknown },
  { defaultLimit = 20, maxLimit = MAX_PAGE_SIZE }: { defaultLimit?: number; maxLimit?: number } = {}
): PageRequest {
  const page = Math.max(1, queryInt(query.page) || 1);
  const limit = clampLimit(query.limit, defaultLimit, maxLimit);
  return { page, limit, skip: (page - 1) * limit };
}

/** Format unique de pagination renvoyé par toutes les listes de l'API. */
export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  pages: number;
}

export function paginationMeta({ page, limit }: Pick<PageRequest, 'page' | 'limit'>, total: number): PaginationMeta {
  return { page, limit, total, pages: Math.ceil(total / limit) };
}
