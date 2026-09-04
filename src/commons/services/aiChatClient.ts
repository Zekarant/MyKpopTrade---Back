import logger from '../utils/logger';
import { isMistralConfigured, mistralChatJson } from './mistralClient';
import { isGeminiConfigured, geminiChatJson } from './geminiClient';

/**
 * Point d'entrée unique pour les fonctionnalités IA du back : essaie Mistral
 * en premier, bascule sur Gemini en cas d'échec (Mistral "La Plateforme" en
 * tier gratuit est best-effort et peut rejeter des requêtes sans prévenir).
 * Les appelants ne connaissent jamais Mistral ni Gemini directement.
 */

export type AiChatProvider = 'mistral' | 'gemini';

/** Levée quand aucun fournisseur configuré n'a pu répondre. */
export class AiChatUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiChatUnavailableError';
  }
}

export const isAiChatConfigured = (): boolean => isMistralConfigured() || isGeminiConfigured();

interface AiChatJsonParams {
  system: string;
  user: string;
}

/**
 * Envoie un couple (system, user) au premier fournisseur disponible et
 * fonctionnel. Retourne aussi `provider`, pour traçabilité (stocké aux côtés
 * du résultat par les appelants).
 */
export const aiChatJson = async (
  params: AiChatJsonParams
): Promise<{ content: string; model: string; provider: AiChatProvider }> => {
  const failures: string[] = [];

  if (isMistralConfigured()) {
    try {
      const { content, model } = await mistralChatJson(params);
      return { content, model, provider: 'mistral' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`mistral: ${message}`);
      if (isGeminiConfigured()) {
        logger.warn('Bascule vers Gemini après échec Mistral', { error: message });
      }
    }
  }

  if (isGeminiConfigured()) {
    try {
      const { content, model } = await geminiChatJson(params);
      return { content, model, provider: 'gemini' };
    } catch (error) {
      failures.push(`gemini: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new AiChatUnavailableError(
    failures.length > 0 ? failures.join(' | ') : 'Aucun fournisseur IA configuré'
  );
};
