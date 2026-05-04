import { HttpError } from '../../../commons/utils/httpError';

export type ShippingMethod = 'national' | 'worldwide' | 'localPickup';

export const SHIPPING_METHODS = {
  NATIONAL: 'national',
  WORLDWIDE: 'worldwide',
  LOCAL_PICKUP: 'localPickup'
} as const;

const ERROR_CODES = {
  INVALID_SHIPPING_METHOD: 'INVALID_SHIPPING_METHOD',
  SHIPPING_METHOD_UNAVAILABLE: 'SHIPPING_METHOD_UNAVAILABLE',
  SHIPPING_COST_MISSING: 'SHIPPING_COST_MISSING',
  SHIPPING_ADDRESS_REQUIRED: 'SHIPPING_ADDRESS_REQUIRED',
  SHIPPING_ADDRESS_INVALID: 'SHIPPING_ADDRESS_INVALID'
} as const;

const FR_POSTAL_CODE = /^\d{5}$/;
const COUNTRY_CODE = /^[A-Z]{2}$/;

const ADDRESS_FIELDS = [
  { key: 'recipientName', label: 'Nom du destinataire', max: 100 },
  { key: 'streetLine1', label: 'Adresse', max: 200 },
  { key: 'postalCode', label: 'Code postal', max: 16 },
  { key: 'city', label: 'Ville', max: 100 }
] as const;

export interface ShippingAddressInput {
  recipientName: unknown;
  streetLine1: unknown;
  streetLine2?: unknown;
  postalCode: unknown;
  city: unknown;
  country?: unknown;
  phone?: unknown;
}

export interface ShippingAddress {
  recipientName: string;
  streetLine1: string;
  streetLine2?: string;
  postalCode: string;
  city: string;
  country: string;
  phone?: string;
}

export interface CheckoutBreakdown {
  productAmount: number;
  shippingAmount: number;
  total: number;
}

/**
 * Récupère le coût de port pour la méthode demandée. Lit les champs nationalCost/
 * worldwideCost et retombe sur le legacy `shippingCost` pour les anciens produits
 * qui n'ont pas encore été ré-édités.
 */
function resolveShippingCost(
  product: any,
  method: ShippingMethod
): number | undefined {
  if (method === SHIPPING_METHODS.LOCAL_PICKUP) return 0;

  const opts = product.shippingOptions ?? {};
  if (method === SHIPPING_METHODS.NATIONAL) {
    return opts.nationalCost ?? opts.shippingCost;
  }
  if (method === SHIPPING_METHODS.WORLDWIDE) {
    return opts.worldwideCost ?? opts.shippingCost;
  }
  return undefined;
}

function isMethodOffered(product: any, method: ShippingMethod): boolean {
  const opts = product.shippingOptions ?? {};
  if (method === SHIPPING_METHODS.NATIONAL) return Boolean(opts.nationalOnly);
  if (method === SHIPPING_METHODS.WORLDWIDE) return Boolean(opts.worldwide);
  if (method === SHIPPING_METHODS.LOCAL_PICKUP) return Boolean(opts.localPickup);
  return false;
}

function assertShippingMethod(value: unknown): ShippingMethod {
  if (value === SHIPPING_METHODS.NATIONAL ||
      value === SHIPPING_METHODS.WORLDWIDE ||
      value === SHIPPING_METHODS.LOCAL_PICKUP) {
    return value;
  }
  throw new HttpError(
    400,
    'Méthode de livraison invalide',
    ERROR_CODES.INVALID_SHIPPING_METHOD
  );
}

/**
 * Calcule le total à payer pour un produit + une méthode de livraison.
 * Lance une HttpError si la méthode n'est pas proposée par le vendeur ou
 * si le coût n'est pas configuré.
 */
export function computeCheckout(
  product: any,
  method: ShippingMethod,
  productPrice: number
): CheckoutBreakdown {
  if (!isMethodOffered(product, method)) {
    throw new HttpError(
      400,
      'Cette méthode de livraison n\'est pas proposée pour ce produit',
      ERROR_CODES.SHIPPING_METHOD_UNAVAILABLE
    );
  }

  const shippingCost = resolveShippingCost(product, method);
  if (shippingCost === undefined) {
    throw new HttpError(
      400,
      'Le coût de livraison n\'est pas configuré pour cette méthode',
      ERROR_CODES.SHIPPING_COST_MISSING
    );
  }

  const productAmount = parseFloat(productPrice.toFixed(2));
  const shippingAmount = parseFloat(shippingCost.toFixed(2));
  const total = parseFloat((productAmount + shippingAmount).toFixed(2));

  return { productAmount, shippingAmount, total };
}

function assertString(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HttpError(400, `${label} requis`, ERROR_CODES.SHIPPING_ADDRESS_INVALID);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new HttpError(
      400,
      `${label} dépasse ${max} caractères`,
      ERROR_CODES.SHIPPING_ADDRESS_INVALID
    );
  }
  return trimmed;
}

function assertOptionalString(value: unknown, label: string, max: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return assertString(value, label, max);
}

function normalizeCountryCode(value: unknown): string {
  if (value === undefined || value === null || value === '') return 'FR';
  if (typeof value !== 'string') {
    throw new HttpError(
      400,
      'Code pays invalide',
      ERROR_CODES.SHIPPING_ADDRESS_INVALID
    );
  }
  const upper = value.trim().toUpperCase();
  if (!COUNTRY_CODE.test(upper)) {
    throw new HttpError(
      400,
      'Code pays doit être au format ISO 2 lettres (ex: FR, BE, DE)',
      ERROR_CODES.SHIPPING_ADDRESS_INVALID
    );
  }
  return upper;
}

/**
 * Valide une adresse de livraison fournie par l'acheteur.
 * Pour la France, applique la regex de code postal à 5 chiffres ;
 * pour les autres pays, accepte tout code respectant la longueur max.
 */
export function validateShippingAddress(input: ShippingAddressInput): ShippingAddress {
  if (!input || typeof input !== 'object') {
    throw new HttpError(
      400,
      'Adresse de livraison requise',
      ERROR_CODES.SHIPPING_ADDRESS_REQUIRED
    );
  }

  const fields: any = {};
  for (const def of ADDRESS_FIELDS) {
    fields[def.key] = assertString((input as any)[def.key], def.label, def.max);
  }
  fields.streetLine2 = assertOptionalString(input.streetLine2, 'Complément d\'adresse', 200);
  fields.country = normalizeCountryCode(input.country);
  fields.phone = assertOptionalString(input.phone, 'Téléphone', 32);

  if (fields.country === 'FR' && !FR_POSTAL_CODE.test(fields.postalCode)) {
    throw new HttpError(
      400,
      'Code postal français invalide (5 chiffres attendus)',
      ERROR_CODES.SHIPPING_ADDRESS_INVALID
    );
  }

  return fields as ShippingAddress;
}

/**
 * Combine la résolution de la méthode et la validation de l'adresse :
 * lance une HttpError si l'adresse manque alors qu'elle est requise.
 */
export function resolveCheckout(
  product: any,
  productPrice: number,
  rawMethod: unknown,
  rawAddress: unknown
): {
  method: ShippingMethod;
  breakdown: CheckoutBreakdown;
  address?: ShippingAddress;
} {
  const method = assertShippingMethod(rawMethod);
  const breakdown = computeCheckout(product, method, productPrice);

  if (method === SHIPPING_METHODS.LOCAL_PICKUP) {
    return { method, breakdown };
  }

  if (rawAddress === undefined || rawAddress === null) {
    throw new HttpError(
      400,
      'Adresse de livraison requise pour cette méthode',
      ERROR_CODES.SHIPPING_ADDRESS_REQUIRED
    );
  }

  const address = validateShippingAddress(rawAddress as ShippingAddressInput);
  return { method, breakdown, address };
}
