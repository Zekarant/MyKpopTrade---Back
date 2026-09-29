/** Plafond par défaut d'une page de liste ; les catalogues ont leur propre plafond. */
export const MAX_PAGE_SIZE = 100;

/** Borne un `limit` de pagination fourni par le client à [1, maxLimit]. */
export function clampLimit(raw: unknown, defaultLimit: number, maxLimit: number): number {
  const parsed = parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return defaultLimit;
  return Math.min(parsed, maxLimit);
}
