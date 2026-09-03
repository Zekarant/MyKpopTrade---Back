import crypto from 'crypto';
import User from '../../../models/userModel';

/**
 * Dérive un pseudo lisible depuis un profil d'authentification sociale.
 * Les valeurs produites respectent `validateUsername` (3-30 caractères,
 * `[a-zA-Z0-9_-]`) et restent modifiables par l'utilisateur.
 */

/** Bornes du champ `username`, alignées sur `commons/utils/validators.ts`. */
const MIN_LENGTH = 3;
const MAX_LENGTH = 30;

/** Borne le nombre de requêtes sur un chemin de connexion. */
const MAX_NUMBERED_ATTEMPTS = 20;

/** Base utilisée quand aucune donnée exploitable n'est fournie. */
const FALLBACK_BASE = 'membre';

export interface SocialIdentityInput {
  /** `profile.displayName` (Google, Facebook) ou `profile.username` (Discord). */
  displayName?: string;
  givenName?: string;
  familyName?: string;
  /** Sert de dernier recours : la partie locale de l'email. */
  email?: string;
}

/** Retire les séparateurs en tête et en fin. */
function trimSeparators(value: string): string {
  return value.replace(/^[-_]+/, '').replace(/[-_]+$/, '');
}

/** « Chloé O'Brien » → « chloe-o-brien ». Rend '' si rien d'exploitable. */
export function slugifyUsername(raw: string | undefined | null): string {
  if (!raw) return '';

  // U+0300–U+036F : marques diacritiques combinantes isolées par NFD.
  const withoutDiacritics = raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const slug = withoutDiacritics.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase();

  return trimSeparators(slug).slice(0, MAX_LENGTH).replace(/[-_]+$/, '');
}

/** Complète un pseudo trop court (« jo ») pour atteindre la longueur minimale. */
function padToMinLength(base: string): string {
  if (base.length >= MIN_LENGTH) return base;
  return `${base}${crypto.randomBytes(2).toString('hex')}`.slice(0, MAX_LENGTH);
}

/** Accole un suffixe en restant sous `MAX_LENGTH`, sans doubler les séparateurs. */
function withSuffix(base: string, suffix: string): string {
  const room = Math.max(MIN_LENGTH, MAX_LENGTH - suffix.length);
  return `${trimSeparators(base.slice(0, room))}${suffix}`;
}

/** Bases candidates dédoublonnées, de la plus lisible à la plus approximative. */
function candidateBases(input: SocialIdentityInput): string[] {
  const fullName = [input.givenName, input.familyName].filter(Boolean).join(' ');
  const emailLocalPart = input.email?.split('@')[0];

  const bases = [
    slugifyUsername(input.displayName),
    slugifyUsername(fullName),
    slugifyUsername(input.givenName),
    slugifyUsername(emailLocalPart)
  ].filter((base) => base.length > 0);

  return [...new Set(bases)];
}

async function isUsernameTaken(username: string): Promise<boolean> {
  return (await User.exists({ username })) !== null;
}

/**
 * Rend un pseudo libre. L'index unique sur `username` reste le garde-fou en cas
 * de course : l'appelant doit traiter une erreur de clé dupliquée au `save()`.
 */
export async function generateUniqueUsername(input: SocialIdentityInput): Promise<string> {
  const bases = [...candidateBases(input).map(padToMinLength), FALLBACK_BASE];

  for (const base of bases) {
    if (!(await isUsernameTaken(base))) return base;
  }

  // Variantes numérotées du meilleur candidat : reste lisible.
  const preferred = bases[0];
  for (let attempt = 2; attempt <= MAX_NUMBERED_ATTEMPTS; attempt++) {
    const candidate = withSuffix(preferred, String(attempt));
    if (!(await isUsernameTaken(candidate))) return candidate;
  }

  // Dernier recours : ne jamais bloquer une inscription.
  return withSuffix(preferred, `-${crypto.randomBytes(3).toString('hex')}`);
}

/** Découpe un nom d'affichage en prénom / nom, pour pré-remplir le profil. */
export function splitDisplayName(displayName?: string): {
  firstName?: string;
  lastName?: string;
} {
  const parts = displayName?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (parts.length === 0) return {};
  if (parts.length === 1) return { firstName: parts[0] };

  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(' ')
  };
}
