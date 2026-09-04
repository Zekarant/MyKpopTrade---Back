import env from '../../config/env';
import logger from '../utils/logger';
import { fetchJsonWithRetry } from './aiHttpRetryClient';

/**
 * Adapter de l'API Mistral (La Plateforme). Seul module couplé au format de
 * Mistral : le reste du code dépend de `mistralChatJson`, jamais du endpoint.
 */

const MISTRAL_CHAT_URL = 'https://api.mistral.ai/v1/chat/completions';
const REQUEST_TIMEOUT_MS = 25_000;
const MAX_ATTEMPTS = 2;
const RETRY_BACKOFF_MS = 1_500;

/** Levée quand Mistral est injoignable, en erreur, ou renvoie une réponse vide. */
export class MistralUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MistralUnavailableError';
  }
}

export const isMistralConfigured = (): boolean => Boolean(env.MISTRAL_API_KEY);

interface MistralChatJsonParams {
  system: string;
  user: string;
  /** Défaut : `env.MISTRAL_MODEL`. */
  model?: string;
  /** Basse par défaut : on veut une analyse reproductible, pas de créativité. */
  temperature?: number;
}

/**
 * Envoie un couple (system, user) à Mistral en forçant une réponse JSON.
 * Retourne le contenu brut de la réponse (chaîne JSON non parsée) et le modèle
 * effectivement utilisé. Un `MistralUnavailableError` est levé après échec des
 * tentatives.
 */
export const mistralChatJson = async ({
  system,
  user,
  model = env.MISTRAL_MODEL,
  temperature = 0.2
}: MistralChatJsonParams): Promise<{ content: string; model: string }> => {
  const apiKey = env.MISTRAL_API_KEY;
  if (!apiKey) {
    throw new MistralUnavailableError('MISTRAL_API_KEY non configurée');
  }

  const body = JSON.stringify({
    model,
    temperature,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ]
  });

  try {
    const content = await fetchJsonWithRetry({
      url: MISTRAL_CHAT_URL,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body,
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxAttempts: MAX_ATTEMPTS,
      backoffMs: RETRY_BACKOFF_MS,
      extractContent: (payload: { choices?: Array<{ message?: { content?: string } }> }) =>
        payload.choices?.[0]?.message?.content?.trim()
    });
    return { content, model };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('Appel Mistral en échec', { error: message, model });
    throw new MistralUnavailableError(message);
  }
};
