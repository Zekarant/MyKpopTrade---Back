import mongoose from 'mongoose';
import Product from '../../models/productModel';
import KpopGroup from '../../models/kpopGroupModel';
import KpopAlbum from '../../models/albumModel';
import SavedSearch from './model';
import { groupKeysForProduct, matchesCriteria, MatchableProduct, ProductCatalogIds } from './matcher';
import type { SavedSearchCriteria } from './validation';
import { NotificationService } from '../notifications/services/notificationService';
import { isBlockedBetween } from '../users/services/userBlockService';
import logger from '../../commons/utils/logger';

/** Au plus une alerte par recherche et par heure : les annonces suivantes sont regroupées. */
export const SAVED_SEARCH_ALERT_COOLDOWN_MS = 60 * 60 * 1000;
/** Borne la liste d'attente d'une recherche très large : seules les plus récentes comptent. */
const MAX_PENDING_PRODUCTS = 50;

const MATCHABLE_FIELDS = 'seller title description price currency condition type kpopGroup kpopMember albumName '
  + 'group member album version isOfficial isAvailable isSold';

type AlertProduct = MatchableProduct & {
  _id: mongoose.Types.ObjectId;
  seller: mongoose.Types.ObjectId;
  group?: mongoose.Types.ObjectId;
  album?: mongoose.Types.ObjectId;
  isAvailable: boolean;
  isSold: boolean;
};

const distinctIds = (values: unknown[]): string[] => [...new Set(values.filter(Boolean).map(String))];

/**
 * Identifiants de groupe et d'album que l'annonce satisfait, comme le repli
 * legacy de `buildCatalogClauses` : champ structuré, identifiant stocké dans
 * `kpopGroup` / `albumName`, ou entité du catalogue portant ce nom exact.
 * Résolu ici une fois, plutôt qu'une requête par recherche candidate.
 */
async function loadProductCatalogIds(product: AlertProduct): Promise<ProductCatalogIds> {
  const [groupsNamedLikeProduct, albumsNamedLikeProduct] = await Promise.all([
    product.kpopGroup ? KpopGroup.find({ name: product.kpopGroup }).select('_id').lean() : [],
    product.albumName ? KpopAlbum.find({ name: product.albumName }).select('_id').lean() : []
  ]);
  return {
    groupIds: distinctIds([product.group, product.kpopGroup, ...groupsNamedLikeProduct.map((group) => group._id)]),
    albumIds: distinctIds([product.album, product.albumName, ...albumsNamedLikeProduct.map((album) => album._id)])
  };
}

type CandidateSearch = { _id: mongoose.Types.ObjectId; user: mongoose.Types.ObjectId; criteria: SavedSearchCriteria };

type ClaimedSearch = {
  _id: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId;
  name: string;
  pendingProductIds: mongoose.Types.ObjectId[];
};

/**
 * Lance les alertes « nouvelle annonce » après la réponse HTTP : la
 * publication ne doit jamais attendre (ni échouer à cause) des alertes.
 */
export function dispatchSavedSearchAlerts(productId: string): void {
  setImmediate(() => {
    notifyMatchingSavedSearches(productId).catch((error) => {
      logger.warn('Alertes de recherches sauvegardées en échec', {
        productId,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  });
}

/**
 * Rattache une annonce visible aux recherches sauvegardées qu'elle satisfait
 * (hors celles de son vendeur) et notifie celles dont le délai entre deux
 * alertes est écoulé. Premier tri indexé par groupe, le reste en mémoire.
 *
 * @returns le nombre de recherches correspondantes.
 */
export async function notifyMatchingSavedSearches(productId: string, now = new Date()): Promise<number> {
  const product = await Product.findById(productId).select(MATCHABLE_FIELDS).lean<AlertProduct | null>();
  // Relu ici : entre la publication et ce traitement, l'annonce a pu être
  // mise en pause (modération) ou vendue.
  if (!product || !product.isAvailable || product.isSold) return 0;

  const catalogIds = await loadProductCatalogIds(product);
  const candidates = SavedSearch.find({
    alertsEnabled: true,
    groupKeys: { $in: groupKeysForProduct(product, catalogIds) },
    user: { $ne: product.seller }
  })
    .select('user criteria')
    .lean<CandidateSearch[]>()
    .cursor();

  let matched = 0;
  // Séquentiel : une annonce populaire ne doit pas ouvrir des milliers
  // d'écritures concurrentes.
  for await (const search of candidates) {
    if (!matchesCriteria(search.criteria, product, catalogIds)) continue;
    // Vérifié après le filtre en mémoire : une requête par recherche retenue, pas par candidate.
    if (await isBlockedBetween(search.user, product.seller)) continue;
    matched++;
    await SavedSearch.updateOne(
      { _id: search._id },
      {
        $push: { pendingProductIds: { $each: [product._id], $slice: -MAX_PENDING_PRODUCTS } },
        $min: { pendingSince: now }
      }
    );
    await flushSavedSearchAlert(search._id, now);
  }
  return matched;
}

/**
 * Envoie l'alerte d'une recherche si des annonces attendent et que le délai
 * depuis la précédente est écoulé. La réclamation atomique (lastNotifiedAt
 * posé et liste vidée en une écriture) évite qu'une publication concurrente
 * ou la purge périodique envoient la même alerte deux fois.
 *
 * @returns true si une notification a été créée.
 */
export async function flushSavedSearchAlert(savedSearchId: mongoose.Types.ObjectId, now = new Date()): Promise<boolean> {
  const cutoff = new Date(now.getTime() - SAVED_SEARCH_ALERT_COOLDOWN_MS);
  const claimed = await SavedSearch.findOneAndUpdate(
    {
      _id: savedSearchId,
      alertsEnabled: true,
      pendingSince: { $exists: true },
      $or: [{ lastNotifiedAt: null }, { lastNotifiedAt: { $lte: cutoff } }]
    },
    { $set: { lastNotifiedAt: now, pendingProductIds: [] }, $unset: { pendingSince: 1 } },
    { returnDocument: 'before', projection: { user: 1, name: 1, pendingProductIds: 1 } }
  ).lean<ClaimedSearch | null>();

  if (!claimed) return false;

  try {
    return await notifyOwner(claimed);
  } catch (error) {
    logger.warn('Alerte de recherche sauvegardée non envoyée', {
      savedSearchId: savedSearchId.toString(),
      error: error instanceof Error ? error.message : String(error)
    });
    return false;
  }
}

async function notifyOwner(search: ClaimedSearch): Promise<boolean> {
  const ids = [...new Set(search.pendingProductIds.map(String))];
  // Les annonces retirées entre-temps ne sont plus annoncées.
  const products = await Product.find({ _id: { $in: ids }, isAvailable: true, isSold: { $ne: true } })
    .select('title')
    .sort({ createdAt: -1 })
    .lean<{ _id: mongoose.Types.ObjectId; title: string }[]>();
  if (products.length === 0) return false;

  const [latest] = products;
  const othersCount = products.length - 1;
  await NotificationService.createNotification({
    recipientId: search.user,
    type: 'saved_search_match',
    title: othersCount === 0
      ? `Nouvelle annonce pour « ${search.name} »`
      : `${products.length} nouvelles annonces pour « ${search.name} »`,
    content: othersCount === 0
      ? `« ${latest.title} » correspond à votre recherche sauvegardée.`
      : `« ${latest.title} » et ${othersCount} autre${othersCount > 1 ? 's' : ''} annonce${othersCount > 1 ? 's' : ''} correspondent à votre recherche sauvegardée.`,
    link: `/products/${latest._id}`,
    data: { savedSearchId: search._id, productIds: products.map((product) => product._id) }
  });
  return true;
}

/**
 * Purge périodique : envoie les alertes regroupées dont le délai est écoulé
 * sans qu'une nouvelle annonce soit venue les déclencher.
 *
 * @returns le nombre de notifications créées.
 */
export async function flushDueSavedSearchAlerts(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - SAVED_SEARCH_ALERT_COOLDOWN_MS);
  const due = SavedSearch.find({
    pendingSince: { $lte: now },
    alertsEnabled: true,
    $or: [{ lastNotifiedAt: null }, { lastNotifiedAt: { $lte: cutoff } }]
  })
    .select('_id')
    .lean<{ _id: mongoose.Types.ObjectId }[]>()
    .cursor();

  let sent = 0;
  for await (const { _id } of due) {
    if (await flushSavedSearchAlert(_id, now)) sent++;
  }
  return sent;
}
