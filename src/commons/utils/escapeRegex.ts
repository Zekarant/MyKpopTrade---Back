/**
 * Échappe les métacaractères d'une saisie utilisateur avant de l'utiliser dans
 * une RegExp ou un `$regex` Mongo : la recherche devient littérale.
 * Sans cela, `(` fait planter la requête (500), `.*` matche tout, et un motif
 * comme `(a+)+$` monopolise le CPU de MongoDB (ReDoS). Cela corrige aussi la
 * recherche exacte sur des noms réels comme « (G)I-DLE ».
 */
export function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
