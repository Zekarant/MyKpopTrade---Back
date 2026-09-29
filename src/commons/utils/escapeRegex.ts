/**
 * Échappe les métacaractères d'une saisie utilisateur pour une RegExp ou un
 * `$regex` Mongo : la recherche devient littérale (ni erreur 500, ni ReDoS).
 */
export function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
