import { z } from 'zod';
import { MODERATION_POLICY_VERSION } from './productModerationPrompt';
import { SUSPECT_KEYWORDS_VERSION } from './suspectKeywords';
import type { ProductModerationResult } from './productModerationTypes';

/**
 * Valide la réponse JSON brute de Mistral. Réponse malformée = rejetée
 * (fail fast) : on préfère ne rien décider plutôt que d'agir sur une réponse
 * douteuse — cette analyse peut mettre une annonce en pause.
 */

const MAX_REASONING_LENGTH = 500;
const MAX_CATEGORIES = 4;
const MAX_CATEGORY_LENGTH = 50;

const rawSchema = z.object({
  suspect: z.boolean(),
  confidence: z.enum(['low', 'medium', 'high']),
  reasoning: z.string().trim().min(1).max(MAX_REASONING_LENGTH),
  categories: z.array(z.string().trim().min(1).max(MAX_CATEGORY_LENGTH)).max(MAX_CATEGORIES).default([])
});

interface ParseModerationResultParams {
  /** Contenu brut de la réponse (chaîne JSON). */
  raw: string;
  /** Modèle ayant produit la réponse. */
  model: string;
  /** Fournisseur ayant produit la réponse (mistral | gemini). */
  provider: string;
  /** Mots-clés locaux ayant déclenché l'analyse. */
  matchedKeywords: string[];
}

/**
 * Parse et valide la sortie du modèle.
 * @throws si le JSON est invalide ou ne respecte pas le schéma attendu.
 */
export const parseModerationResult = ({
  raw,
  model,
  provider,
  matchedKeywords
}: ParseModerationResultParams): ProductModerationResult => {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error('réponse IA non parsable en JSON');
  }

  const parsed = rawSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`réponse IA hors schéma : ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
  }

  const data = parsed.data;

  return {
    suspect: data.suspect,
    confidence: data.confidence,
    reasoning: data.reasoning,
    categories: data.suspect ? data.categories : [],
    matchedKeywords,
    keywordsVersion: SUSPECT_KEYWORDS_VERSION,
    policyVersion: MODERATION_POLICY_VERSION,
    model,
    provider,
    analyzedAt: new Date()
  };
};
