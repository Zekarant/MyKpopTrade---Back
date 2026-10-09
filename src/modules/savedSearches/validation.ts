import { z } from 'zod';
import mongoose from 'mongoose';
import type { IProduct } from '../../models/productModel';

const CONDITIONS = ['new', 'likeNew', 'good', 'fair', 'poor'] as const satisfies readonly IProduct['condition'][];
const PRODUCT_TYPES = ['photocard', 'album', 'merch', 'other'] as const satisfies readonly IProduct['type'][];
const CURRENCIES = ['EUR', 'USD', 'KRW', 'JPY', 'GBP'] as const;

const MAX_NAME_LENGTH = 60;
/** Même borne que les suggestions de recherche : au-delà, ce n'est plus une saisie. */
const MAX_QUERY_LENGTH = 100;
const MAX_LABEL_LENGTH = 100;
/** Le front n'envoie qu'un groupe / membre ; la marge couvre un futur multi-choix. */
const MAX_LIST_ITEMS = 10;

const labelList = z.array(z.string().trim().min(1).max(MAX_LABEL_LENGTH)).max(MAX_LIST_ITEMS);

/** Un champ inconnu est refusé, pas ignoré : il trahit une erreur du client. */
const unknownFieldError = (fallbackMessage: string) => ({
  error: (issue: { code?: string; keys?: string[] }) =>
    issue.code === 'unrecognized_keys'
      ? `Champ non autorisé : ${(issue.keys ?? []).join(', ')}`
      : fallbackMessage
});

const priceSchema = z.number({ error: 'Le prix doit être un nombre' }).min(0, 'Le prix ne peut pas être négatif');

/** Mêmes bornes que `parseCatalogCriteria` (productCatalogService). */
const MAX_MEMBER_LENGTH = 100;
const MAX_VERSION_LENGTH = 50;

const catalogIdSchema = (label: string) =>
  z.string({ error: `Identifiant ${label} invalide` })
    .refine((value) => mongoose.Types.ObjectId.isValid(value), `Identifiant ${label} invalide`);

const catalogTextSchema = (label: string, maxLength: number) =>
  z.string({ error: `${label} doit être un texte` })
    .trim()
    .max(maxLength, `${label} invalide (texte de ${maxLength} caractères maximum)`);

/**
 * Critères d'une recherche sauvegardée : le sous-ensemble de `SearchFilters`
 * (searchService) que la recherche avancée applique réellement. Liste
 * fermée : un champ inconnu est refusé plutôt que stocké.
 */
export const criteriaSchema = z
  .strictObject({
    query: z.string().trim().max(MAX_QUERY_LENGTH).optional(),
    groups: labelList.optional(),
    members: labelList.optional(),
    albums: labelList.optional(),
    priceRange: z
      .strictObject({ min: priceSchema.optional(), max: priceSchema.optional() })
      .refine(
        ({ min, max }) => min === undefined || max === undefined || min <= max,
        'Le prix minimum doit être inférieur ou égal au prix maximum'
      )
      .optional(),
    condition: z.array(z.enum(CONDITIONS, { error: 'État invalide' })).max(CONDITIONS.length).optional(),
    type: z.enum(PRODUCT_TYPES, { error: 'Type invalide' }).optional(),
    currency: z.enum(CURRENCIES, { error: 'Devise non supportée' }).optional(),
    // Critères du catalogue (`CatalogCriteria`) : groupe et album par identifiant.
    group: catalogIdSchema('de groupe').optional(),
    member: catalogTextSchema('Membre', MAX_MEMBER_LENGTH).optional(),
    album: catalogIdSchema('d\'album').optional(),
    version: catalogTextSchema('Version', MAX_VERSION_LENGTH).optional(),
    isOfficial: z.boolean({ error: 'isOfficial doit être un booléen' }).optional()
  }, unknownFieldError('Critères de recherche invalides'))
  .transform(compactCriteria)
  .refine(
    (criteria) => Object.keys(criteria).length > 0,
    'Une recherche sauvegardée doit contenir au moins un critère'
  );

export type SavedSearchCriteria = z.output<typeof criteriaSchema>;

type RawCriteria = {
  query?: string;
  groups?: string[];
  members?: string[];
  albums?: string[];
  priceRange?: { min?: number; max?: number };
  condition?: IProduct['condition'][];
  type?: IProduct['type'];
  currency?: (typeof CURRENCIES)[number];
  group?: string;
  member?: string;
  album?: string;
  version?: string;
  isOfficial?: boolean;
};

/**
 * Retire les critères vides (texte vide, liste vide, fourchette sans borne) :
 * la page de recherche envoie ses champs non remplis, qui ne filtrent rien.
 */
function compactCriteria(criteria: RawCriteria): RawCriteria {
  const compacted: RawCriteria = {};
  if (criteria.query) compacted.query = criteria.query;
  if (criteria.groups?.length) compacted.groups = criteria.groups;
  if (criteria.members?.length) compacted.members = criteria.members;
  if (criteria.albums?.length) compacted.albums = criteria.albums;
  if (criteria.priceRange && (criteria.priceRange.min !== undefined || criteria.priceRange.max !== undefined)) {
    compacted.priceRange = criteria.priceRange;
  }
  if (criteria.condition?.length) compacted.condition = criteria.condition;
  if (criteria.type) compacted.type = criteria.type;
  if (criteria.currency) compacted.currency = criteria.currency;
  if (criteria.group) compacted.group = criteria.group;
  if (criteria.member) compacted.member = criteria.member;
  if (criteria.album) compacted.album = criteria.album;
  if (criteria.version) compacted.version = criteria.version;
  // `false` est un vrai critère (articles non officiels), seul l'absent est ignoré.
  if (criteria.isOfficial !== undefined) compacted.isOfficial = criteria.isOfficial;
  return compacted;
}

const nameSchema = z
  .string({ error: 'Le nom doit être un texte' })
  .trim()
  .min(1, 'Le nom est obligatoire')
  .max(MAX_NAME_LENGTH, `Le nom ne peut pas dépasser ${MAX_NAME_LENGTH} caractères`);

const alertsEnabledSchema = z.boolean({ error: 'alertsEnabled doit être un booléen' });

const createSchema = z.strictObject({
  name: nameSchema,
  criteria: criteriaSchema,
  alertsEnabled: alertsEnabledSchema.optional()
}, unknownFieldError('Recherche sauvegardée invalide'));

/** Seuls le nom et les alertes se modifient : changer de critères, c'est une autre recherche. */
const updateSchema = z
  .strictObject({ name: nameSchema, alertsEnabled: alertsEnabledSchema }, unknownFieldError('Recherche sauvegardée invalide'))
  .partial()
  .refine((changes) => Object.keys(changes).length > 0, 'Aucune modification fournie');

export type SavedSearchCreateInput = z.output<typeof createSchema>;
export type SavedSearchUpdateInput = z.output<typeof updateSchema>;

type ValidationResult<T> = { value: T; error?: undefined } | { value?: undefined; error: string };

/** Premier message d'erreur, préfixé du champ fautif pour que le client sache lequel corriger. */
function toValidationResult<T>(
  result: { success: true; data: T } | { success: false; error: z.ZodError }
): ValidationResult<T> {
  if (result.success) return { value: result.data };
  const [issue] = result.error.issues;
  const field = issue.path.join('.');
  return { error: field ? `${field} : ${issue.message}` : issue.message };
}

export const validateSavedSearchCreate = (data: unknown) => toValidationResult(createSchema.safeParse(data));
export const validateSavedSearchUpdate = (data: unknown) => toValidationResult(updateSchema.safeParse(data));
