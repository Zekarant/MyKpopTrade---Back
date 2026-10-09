import { z } from 'zod';

const CURRENCIES = ['EUR', 'USD', 'KRW', 'JPY', 'GBP'] as const;
const CONDITIONS = ['new', 'likeNew', 'good', 'fair', 'poor'] as const;
const PRODUCT_TYPES = ['photocard', 'album', 'merch', 'other'] as const;
const MAX_IMAGES = 10;

/** Message « obligatoire » quand le champ manque, `invalidMessage` sinon. */
const requiredOr = (requiredMessage: string, invalidMessage: string) => ({
  error: (issue: { input?: unknown }) => (issue.input === undefined ? requiredMessage : invalidMessage)
});

/**
 * La création passe par un formulaire multipart, qui envoie tout en texte :
 * "12.5" vaut 12.5 et "true" / "false" des booléens. Une chaîne vide ou non
 * numérique reste invalide.
 */
const fromNumericString = (value: unknown) =>
  typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : value;

const fromBooleanString = (value: unknown) => {
  if (typeof value !== 'string') return value;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return value;
};

const booleanField = (label: string) =>
  z.preprocess(fromBooleanString, z.boolean({ error: `${label} doit être un booléen` }));

const shippingCostField = z
  .preprocess(
    fromNumericString,
    z.number({ error: 'Les frais de port doivent être un nombre' }).min(0, 'Les frais de port ne peuvent pas être négatifs')
  )
  .optional();

const shippingOptionsSchema = z.strictObject({
  worldwide: booleanField('worldwide').default(false),
  nationalOnly: booleanField('nationalOnly').default(true),
  localPickup: booleanField('localPickup').default(false),
  nationalCost: shippingCostField,
  worldwideCost: shippingCostField,
  shippingCost: shippingCostField
}, { error: 'Options de livraison invalides' });

/** Champs d'une annonce, sans valeur par défaut : une mise à jour partielle n'en reçoit aucune. */
const productFields = {
  title: z.string(requiredOr('Le titre est obligatoire', 'Le titre doit être un texte'))
    .min(3, 'Le titre doit contenir au moins 3 caractères')
    .max(100, 'Le titre ne peut pas dépasser 100 caractères'),

  description: z.string(requiredOr('La description est obligatoire', 'La description doit être un texte'))
    .min(10, 'La description doit contenir au moins 10 caractères')
    .max(1000, 'La description ne peut pas dépasser 1000 caractères'),

  price: z.preprocess(
    fromNumericString,
    z.number(requiredOr('Le prix est obligatoire', 'Le prix doit être un nombre')).min(0, 'Le prix ne peut pas être négatif')
  ),

  currency: z.enum(CURRENCIES, { error: 'Devise non supportée' }),

  condition: z.enum(CONDITIONS, requiredOr('La condition est obligatoire', 'Condition invalide')),

  category: z.string(requiredOr('La catégorie est obligatoire', 'La catégorie doit être un texte'))
    .min(1, 'La catégorie est obligatoire'),

  type: z.enum(PRODUCT_TYPES, requiredOr('Le type est obligatoire', 'Type invalide')),

  kpopGroup: z.string(requiredOr('Le groupe K-pop est obligatoire', 'Le groupe K-pop doit être un texte'))
    .min(1, 'Le groupe K-pop est obligatoire'),

  kpopMember: z.string({ error: 'Le membre doit être un texte' }).nullish(),

  albumName: z.string({ error: 'L\'album doit être un texte' }).nullish(),

  allowOffers: booleanField('allowOffers'),

  shippingOptions: shippingOptionsSchema
};

/** Un champ inconnu est refusé, pas ignoré : il trahit une erreur du client. */
const unknownFieldError = {
  error: (issue: { code?: string; keys?: string[] }) =>
    issue.code === 'unrecognized_keys'
      ? `Champ non autorisé : ${(issue.keys ?? []).join(', ')}`
      : 'Données de produit invalides'
};

/**
 * Schéma de validation pour la création de produits
 */
export const productSchema = z.strictObject({
  ...productFields,
  currency: productFields.currency.default('EUR'),
  allowOffers: productFields.allowOffers.default(false),
  shippingOptions: productFields.shippingOptions.default({
    worldwide: false,
    nationalOnly: true,
    localPickup: false
  }),
  images: z.array(z.string(), requiredOr('Les images sont obligatoires', 'Les images sont invalides'))
    .min(1, 'Au moins une image est requise')
    .max(MAX_IMAGES, `Maximum ${MAX_IMAGES} images autorisées`)
}, unknownFieldError);

/**
 * Mise à jour : mêmes règles qu'à la création, chaque champ devenant
 * facultatif. Les images ont leurs propres routes ; `isAvailable` met en pause
 * ou remet en vente.
 */
export const productUpdateSchema = z.strictObject({
  ...productFields,
  isAvailable: booleanField('isAvailable')
}, unknownFieldError).partial();

type ValidationResult<T> = { value: T; error?: undefined } | { value?: undefined; error: string };

function toValidationResult<T>(
  result: { success: true; data: T } | { success: false; error: z.ZodError }
): ValidationResult<T> {
  return result.success ? { value: result.data } : { error: result.error.issues[0].message };
}

/**
 * Valide les données d'un produit à créer
 * @returns la valeur normalisée (nombres, booléens, valeurs par défaut), ou le premier message d'erreur.
 */
export const validateProductData = (data: unknown) => toValidationResult(productSchema.safeParse(data));

/**
 * Valide les champs modifiés d'un produit
 * @returns les champs normalisés, ou le premier message d'erreur.
 */
export const validateProductUpdate = (data: unknown) => toValidationResult(productUpdateSchema.safeParse(data));
