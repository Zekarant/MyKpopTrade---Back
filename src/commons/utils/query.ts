/**
 * Paramètre de query à valeur unique. Un paramètre répété (`?status=a&status=b`)
 * arrive en tableau : Mongoose le lirait comme un `$in` et les méthodes de chaîne
 * planteraient, on l'ignore donc.
 */
export function queryString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Entier lu dans la query ; NaN si absent ou invalide (à combiner avec `|| défaut`). */
export function queryInt(value: unknown): number {
  return parseInt(queryString(value) ?? '', 10);
}
