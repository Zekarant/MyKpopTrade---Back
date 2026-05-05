/**
 * Comparaisons et arithmétique monétaire FP-safe.
 *
 * Les flottants IEEE-754 (`0.1 + 0.2 !== 0.3`) sont incompatibles avec les
 * comparaisons d'égalité ou « ≤ » sur des montants. On convertit en
 * « cents » (entiers) pour toute opération de validation, puis on revient
 * en décimal pour l'API PayPal qui attend une chaîne « X.XX ».
 *
 * NB : on suppose une devise à 2 décimales (EUR/USD/GBP). Les devises sans
 * décimales (JPY) ou à 3 décimales (KWD) ne sont pas supportées ici.
 */

const DECIMALS = 2;
const SCALE = 10 ** DECIMALS;

export function toCents(amount: number): number {
  if (!Number.isFinite(amount)) {
    throw new Error(`Montant invalide : ${amount}`);
  }
  return Math.round(amount * SCALE);
}

export function fromCents(cents: number): number {
  return cents / SCALE;
}

/**
 * Formate un montant pour l'API PayPal (toujours 2 décimales, point décimal).
 */
export function formatForPayPal(amount: number): string {
  return (toCents(amount) / SCALE).toFixed(DECIMALS);
}

export function leq(a: number, b: number): boolean {
  return toCents(a) <= toCents(b);
}

export function gt(a: number, b: number): boolean {
  return toCents(a) > toCents(b);
}

export function add(a: number, b: number): number {
  return fromCents(toCents(a) + toCents(b));
}

export function subtract(a: number, b: number): number {
  return fromCents(toCents(a) - toCents(b));
}
