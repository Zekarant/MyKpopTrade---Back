/**
 * Ne garde d'un corps de requête que les champs modifiables : le reste
 * (compteurs, abonnés, champs techniques) ne doit pas venir du client.
 */
export function pickFields<K extends string>(
  source: Record<string, unknown>,
  keys: readonly K[]
): Partial<Record<K, unknown>> {
  const picked: Partial<Record<K, unknown>> = {};
  for (const key of keys) {
    if (source[key] !== undefined) picked[key] = source[key];
  }
  return picked;
}
