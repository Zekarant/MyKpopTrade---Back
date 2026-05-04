import axios from 'axios';
import { HttpError } from '../../../commons/utils/httpError';
import logger from '../../../commons/utils/logger';

const BAN_URL = 'https://api-adresse.data.gouv.fr/search/';
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 15;
const REQUEST_TIMEOUT_MS = 5000;

export interface AddressResult {
  label: string;
  streetLine1: string;
  postalCode: string;
  city: string;
  country: 'FR';
  context: string;
  score: number;
}

export interface LookupQuery {
  q?: unknown;
  postalCode?: unknown;
  city?: unknown;
  limit?: unknown;
}

function sanitizeQueryString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, max);
}

function clampLimit(value: unknown): number {
  const n = typeof value === 'string' ? parseInt(value, 10) : Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

function mapFeature(feature: any): AddressResult | null {
  const props = feature?.properties;
  if (!props) return null;

  const streetLine1 = (props.name ?? '').trim();
  const postalCode = (props.postcode ?? '').trim();
  const city = (props.city ?? '').trim();

  if (!postalCode || !city) return null;

  return {
    label: props.label ?? `${streetLine1} ${postalCode} ${city}`.trim(),
    streetLine1,
    postalCode,
    city,
    country: 'FR',
    context: props.context ?? '',
    score: typeof props.score === 'number' ? props.score : 0
  };
}

/**
 * Interroge l'API gouvernementale Base Adresse Nationale pour proposer des
 * adresses françaises correspondant à une saisie partielle ou un code postal.
 * Retourne au plus `limit` résultats triés par score décroissant.
 *
 * - Au moins l'un des paramètres `q` ou `postalCode` doit être fourni.
 * - Le paramètre `q` est privilégié pour l'autocomplete d'adresse complète,
 *   `postalCode` seul renvoie les villes du code postal.
 */
export async function lookupAddress(query: LookupQuery): Promise<AddressResult[]> {
  const q = sanitizeQueryString(query.q, 200);
  const postalCode = sanitizeQueryString(query.postalCode, 10);
  const city = sanitizeQueryString(query.city, 100);
  const limit = clampLimit(query.limit);

  if (!q && !postalCode) {
    throw new HttpError(400, 'Paramètre q ou postalCode requis');
  }

  const banQuery = q ?? postalCode!;

  const params: Record<string, string | number> = {
    q: banQuery,
    limit,
    autocomplete: 1
  };
  if (postalCode) params.postcode = postalCode;
  if (city) params.city = city;

  try {
    const response = await axios.get(BAN_URL, {
      params,
      timeout: REQUEST_TIMEOUT_MS,
      headers: { Accept: 'application/json' }
    });

    const features = Array.isArray(response.data?.features) ? response.data.features : [];
    return features
      .map(mapFeature)
      .filter((r: AddressResult | null): r is AddressResult => r !== null);
  } catch (error: any) {
    if (axios.isAxiosError(error) && error.response) {
      logger.warn('BAN a renvoyé une erreur', {
        status: error.response.status,
        params
      });
      throw new HttpError(502, 'Service d\'autocomplétion d\'adresse indisponible');
    }
    logger.error('Erreur lors de l\'appel à BAN', {
      error: error instanceof Error ? error.message : String(error)
    });
    throw new HttpError(502, 'Service d\'autocomplétion d\'adresse indisponible');
  }
}
