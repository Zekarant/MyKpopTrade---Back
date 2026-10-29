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

/** Arrondi au centime le plus proche (montants calculés : frais, totaux, soldes). */
export function roundToCents(amount: number): number {
  return fromCents(toCents(amount));
}

/**
 * `percent` % de `amount`, arrondi au centime le plus proche (0,5 vers le haut).
 * Calculé sur des centimes entiers : `1.45 * 10 / 100` donnerait 0,14 à cause
 * des flottants (`0.145 * 100 = 14.499999…`), au lieu de 0,15.
 */
export function percentOf(amount: number, percent: number): number {
  return fromCents(Math.round(toCents(amount) * percent / 100));
}

/**
 * Arrondi au centime supérieur : un minimum exprimé en pourcentage d'un prix ne
 * doit jamais tomber sous la règle (50 % de 19,99 € → 10,00 €, pas 9,995 €).
 * La marge absorbe l'erreur des flottants (`0.1 * 3 * 100 = 30.000000000000004`).
 * Même calcul que `offerRules.ts` côté front.
 */
export function ceilToCents(amount: number): number {
  if (!Number.isFinite(amount)) {
    throw new Error(`Montant invalide : ${amount}`);
  }
  return Math.ceil(amount * SCALE - 1e-9) / SCALE;
}

/**
 * Formate un montant pour l'API PayPal (toujours 2 décimales, point décimal).
 */
export function formatForPayPal(amount: number): string {
  return (toCents(amount) / SCALE).toFixed(DECIMALS);
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
