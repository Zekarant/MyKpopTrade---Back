import env from '../../config/env';
import logger from '../utils/logger';
import { fetchJsonWithRetry } from './aiHttpRetryClient';

/**
 * Adapter de l'API Gemini (Google Generative Language). Solution de secours
 * quand Mistral est indisponible — seul module couplé au format Gemini.
 */

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const REQUEST_TIMEOUT_MS = 25_000;
const MAX_ATTEMPTS = 2;
const RETRY_BACKOFF_MS = 1_500;

/** Levée quand Gemini est injoignable, en erreur, ou renvoie une réponse vide. */
export class GeminiUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeminiUnavailableError';
  }
}

export const isGeminiConfigured = (): boolean => Boolean(env.GEMINI_API_KEY);

interface GeminiChatJsonParams {
  system: string;
  user: string;
  /** Défaut : `env.GEMINI_MODEL`. */
  model?: string;
  /** Basse par défaut : on veut une analyse reproductible, pas de créativité. */
  temperature?: number;
}

/**
 * Envoie un couple (system, user) à Gemini en forçant une réponse JSON.
 * Même contrat que `mistralChatJson` : retourne le contenu brut (chaîne JSON
 * non parsée) et le modèle effectivement utilisé. Un `GeminiUnavailableError`
 * est levé après échec des tentatives.
 */
export const geminiChatJson = async ({
  system,
  user,
  model = env.GEMINI_MODEL,
  temperature = 0.2
}: GeminiChatJsonParams): Promise<{ content: string; model: string }> => {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new GeminiUnavailableError('GEMINI_API_KEY non configurée');
  }

  const url = `${GEMINI_BASE_URL}/${model}:generateContent?key=${apiKey}`;
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: {
      temperature,
      responseMimeType: 'application/json'
    }
  });

  try {
    const content = await fetchJsonWithRetry({
      url,
      headers: { 'Content-Type': 'application/json' },
      body,
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxAttempts: MAX_ATTEMPTS,
      backoffMs: RETRY_BACKOFF_MS,
      extractErrorMessage: (payload: { error?: { message?: string } }) => payload.error?.message,
      extractContent: (payload: {
        candidates?: Array<{
          content?: { parts?: Array<{ text?: string; thought?: boolean }> };
        }>;
      }) => {
        // Les modèles "thinking" (ex. gemini-3.6-flash) peuvent renvoyer un
        // bloc de raisonnement (`thought: true`) avant la vraie réponse : on
        // prend le premier part textuel qui n'en est pas un, jamais parts[0]
        // aveuglément.
        const parts = payload.candidates?.[0]?.content?.parts ?? [];
        return parts.find((part) => part.text && !part.thought)?.text?.trim();
      }
    });
    return { content, model };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('Appel Gemini en échec', { error: message, model });
    throw new GeminiUnavailableError(message);
  }
};
