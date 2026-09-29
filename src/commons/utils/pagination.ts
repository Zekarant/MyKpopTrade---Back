/**
 * Plafond par défaut d'une page de liste. Aucun écran du front ne demande plus
 * de 50 éléments ; les catalogues (groupes, albums, recherche) ont leur propre
 * plafond, plus haut.
 */
export const MAX_PAGE_SIZE = 100;

/**
 * Lit un `limit` de pagination fourni par le client et le borne à
 * [1, maxLimit]. Sans plafond, `?limit=100000` chargeait toute une collection
 * (plus ses requêtes d'enrichissement) en une requête.
 */
export function clampLimit(raw: unknown, defaultLimit: number, maxLimit: number): number {
  const parsed = parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return defaultLimit;
  return Math.min(parsed, maxLimit);
}
