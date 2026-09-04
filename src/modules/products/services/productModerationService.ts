import mongoose from 'mongoose';
import Product, { IProduct } from '../../../models/productModel';
import logger from '../../../commons/utils/logger';
import { dispatchAdminAlert } from '../../../commons/services/adminAlertService';
import { isAiChatConfigured, aiChatJson } from '../../../commons/services/aiChatClient';
import { NotificationService } from '../../notifications/services/notificationService';
import { findSuspectKeywords } from './suspectKeywords';
import { buildModerationPrompt } from './productModerationPrompt';
import { parseModerationResult } from './productModerationParser';
import type { ProductModerationInput, ProductModerationResult } from './productModerationTypes';

const CATEGORY_LABELS: Record<string, string> = {
  counterfeit: 'Contrefaçon',
  off_platform_payment: 'Contournement de paiement',
  prohibited_item: 'Objet interdit',
  other: 'Autre'
};

const describeCategories = (categories: string[]): string =>
  categories.length
    ? categories.map((c) => CATEGORY_LABELS[c] ?? c).join(', ')
    : 'non catégorisé';

export const buildModerationInput = (
  product: Pick<IProduct, 'title' | 'description' | 'price' | 'currency' | 'category'>,
  matchedKeywords: string[]
): ProductModerationInput => ({
  title: product.title,
  description: product.description,
  price: product.price,
  currency: product.currency,
  category: product.category,
  matchedKeywords
});

/**
 * Lance la modération IA d'une annonce si elle contient un mot-clé suspect.
 * Fire-and-forget : n'attend rien, ne lève jamais. Sans clé Mistral configurée,
 * ne fait rien (le filtre par mots-clés seul ne déclenche aucune action).
 */
export const dispatchProductModeration = (productId: string): void => {
  if (!isAiChatConfigured()) return;

  void runModeration(productId).catch((error) => {
    // Filet de sécurité pour un échec imprévu (ex. DB indisponible) en dehors
    // de l'appel Mistral lui-même, déjà géré (et alerté) dans runModeration.
    logger.warn('Modération IA annonce en échec', {
      productId,
      error: error instanceof Error ? error.message : String(error)
    });
  });
};

const runModeration = async (productId: string): Promise<void> => {
  if (!mongoose.Types.ObjectId.isValid(productId)) return;

  const product = await Product.findById(productId);
  if (!product || product.moderationFlag) return;

  const matchedKeywords = findSuspectKeywords(product.title, product.description);
  if (matchedKeywords.length === 0) return; // rien à analyser : pas d'appel Mistral, pas de coût

  const input = buildModerationInput(product, matchedKeywords);
  const { system, user } = buildModerationPrompt(input);

  // L'IA n'ayant pas tranché, on ne bloque jamais l'annonce sur un échec :
  // on se contente d'alerter les admins pour une vérification manuelle.
  // aiChatJson essaie Mistral puis bascule sur Gemini si configuré.
  let content: string;
  let model: string;
  let provider: string;
  try {
    ({ content, model, provider } = await aiChatJson({ system, user }));
  } catch (error) {
    logger.warn('Appel IA en échec pour une annonce suspecte', {
      productId,
      matchedKeywords,
      error: error instanceof Error ? error.message : String(error)
    });
    alertAnalysisFailed(product, matchedKeywords);
    return;
  }

  let result: ProductModerationResult;
  try {
    result = parseModerationResult({ raw: content, model, provider, matchedKeywords });
  } catch (error) {
    logger.warn('Réponse IA invalide pour une annonce suspecte', {
      productId,
      matchedKeywords,
      provider,
      error: error instanceof Error ? error.message : String(error)
    });
    alertAnalysisFailed(product, matchedKeywords);
    return;
  }

  // Recharge pour éviter d'écraser une revue admin intervenue entre-temps.
  const fresh = await Product.findById(productId);
  if (!fresh || fresh.moderationFlag) return;
  fresh.moderationFlag = result;
  if (result.suspect) {
    fresh.isAvailable = false;
  }
  await fresh.save();

  logger.info('Modération IA annonce effectuée', {
    productId,
    suspect: result.suspect,
    confidence: result.confidence,
    categories: result.categories,
    provider,
    model
  });

  if (!result.suspect) return;

  notifySeller(fresh, result);
  alertAdmins(fresh, result);
};

const notifySeller = (product: IProduct, result: ProductModerationResult): void => {
  NotificationService.createNotification({
    recipientId: product.seller,
    type: 'product_flagged',
    title: 'Votre annonce a été mise en pause pour vérification',
    content: `« ${product.title} » est en cours de vérification par notre équipe et n'est plus visible temporairement.`,
    link: `/products/${product._id}`,
    data: { productId: product._id, categories: result.categories }
  }).catch((error) => {
    logger.warn('Erreur notification vendeur (annonce suspecte)', {
      productId: product._id,
      error: error instanceof Error ? error.message : String(error)
    });
  });
};

/**
 * L'analyse IA a échoué (Mistral injoignable ou réponse invalide) alors qu'un
 * mot-clé suspect a été détecté. L'annonce reste publiée — sans verdict, on ne
 * pénalise pas le vendeur — mais un admin doit vérifier manuellement.
 */
const alertAnalysisFailed = (
  product: Pick<IProduct, '_id' | 'title'>,
  matchedKeywords: string[]
): void => {
  dispatchAdminAlert({
    event: 'product.moderation_failed',
    severity: 'warning',
    title: 'Analyse IA indisponible pour une annonce suspecte',
    summary: `« ${product.title} » contient un mot-clé suspect mais l'analyse IA a échoué. Annonce restée publiée, vérification manuelle nécessaire.`,
    adminTab: 'products',
    fields: [
      { name: 'Mots-clés déclencheurs', value: matchedKeywords.join(', ') }
    ],
    data: { productId: product._id, matchedKeywords }
  });
};

const alertAdmins = (product: IProduct, result: ProductModerationResult): void => {
  dispatchAdminAlert({
    event: 'product.suspect',
    severity: 'warning',
    title: 'Annonce suspecte mise en pause automatiquement',
    summary: `« ${product.title} » — ${describeCategories(result.categories)} (confiance ${result.confidence}). Analyse IA, à confirmer.`,
    adminTab: 'products',
    fields: [
      { name: 'Catégories', value: describeCategories(result.categories), inline: true },
      { name: 'Confiance', value: result.confidence, inline: true },
      { name: 'Mots-clés déclencheurs', value: result.matchedKeywords.join(', ') },
      { name: 'Analyse', value: result.reasoning }
    ],
    data: { productId: product._id, categories: result.categories }
  });
};
