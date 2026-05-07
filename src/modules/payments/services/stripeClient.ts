import Stripe from 'stripe';

/**
 * SDK Stripe singleton.
 *
 * `apiVersion` est pin pour éviter qu'un upgrade côté Stripe casse silencieusement
 * le code. Mettre à jour explicitement quand on a relu le changelog.
 */
let stripeInstance: Stripe | null = null;

export function getStripe(): Stripe {
  if (stripeInstance) return stripeInstance;

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new Error('STRIPE_SECRET_KEY manquant dans la configuration');
  }

  // Pas d'apiVersion explicite : on utilise celle pin sur le compte Stripe
  // (configurable depuis le dashboard). Évite les frictions avec les versions
  // preview (Accounts v2, etc.) tant qu'on n'en a pas besoin.
  stripeInstance = new Stripe(secretKey, {
    typescript: true
  });

  return stripeInstance;
}

/**
 * Pourcentage de commission plateforme prélevée sur chaque paiement.
 * 0 = 100 % au vendeur (Stripe ne prélève alors que ses propres frais).
 */
export function getPlatformFeePercent(): number {
  const raw = parseFloat(process.env.PLATFORM_FEE_PERCENT || '0');
  return Number.isFinite(raw) && raw >= 0 ? raw : 0;
}

/**
 * Convertit un montant EUR en centimes (Stripe travaille en plus petite unité).
 */
export function toCents(amount: number): number {
  return Math.round(amount * 100);
}

/**
 * Convertit un montant en centimes vers EUR (number à 2 décimales).
 */
export function fromCents(cents: number): number {
  return Math.round(cents) / 100;
}
