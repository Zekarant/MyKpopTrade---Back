/**
 * Types de l'analyse IA de modération d'une annonce. Déclenchée uniquement
 * quand un mot-clé suspect est trouvé (`findSuspectKeywords`) — pas sur
 * toutes les annonces.
 */

export type ModerationCategory = 'counterfeit' | 'off_platform_payment' | 'prohibited_item' | 'other';

export type ModerationConfidence = 'low' | 'medium' | 'high';

export interface ProductModerationInput {
  title: string;
  description: string;
  price: number;
  currency: string;
  category: string;
  /** Mots-clés locaux ayant déclenché cette analyse. */
  matchedKeywords: string[];
}

/** Résultat validé, stocké sur `product.moderationFlag`. */
export interface ProductModerationResult {
  suspect: boolean;
  confidence: ModerationConfidence;
  reasoning: string;
  categories: string[];
  matchedKeywords: string[];
  keywordsVersion: string;
  policyVersion: string;
  model: string;
  /** Fournisseur IA ayant produit ce résultat (Mistral en priorité, Gemini en secours). */
  provider: string;
  analyzedAt: Date;
}
