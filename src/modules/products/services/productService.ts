import mongoose from 'mongoose';
import path from 'path';
import fs from 'fs';
import Product, { IProduct } from '../../../models/productModel';
import User from '../../../models/userModel';
import Payment, { IPayment } from '../../../models/paymentModel';
import KpopGroup from '../../../models/kpopGroupModel';
import KpopAlbum from '../../../models/albumModel';
import { HttpError } from '../../../commons/utils/httpError';
import { clampLimit, MAX_PAGE_SIZE } from '../../../commons/utils/pagination';
import { queryInt, queryString } from '../../../commons/utils/query';
import { validateProductData, validateProductUpdate } from './productValidationService';
import { notifyWishlistPriceDrop, notifyWishlistUnavailable } from './wishlistAlertService';
import { dispatchProductModeration, awaitsModerationVerdict } from './productModerationService';
import { dispatchSavedSearchAlerts } from '../../savedSearches/alertService';
import { assertCatalogConsistency, buildCatalogClauses, parseCatalogCriteria } from './productCatalogService';

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = MAX_PAGE_SIZE;
const DEFAULT_LIST_PAGE = 1;
const DEFAULT_LIST_SORT = '-createdAt';

/**
 * Tris proposés sur le catalogue public. Un tri libre laissait trier sur
 * n'importe quel champ, y compris internes (modération, acheteur), et sur des
 * champs non indexés.
 */
const ALLOWED_LIST_SORTS = new Set([
  'createdAt', '-createdAt',
  'price', '-price',
  'views', '-views',
  'favorites', '-favorites'
]);

const ALLOWED_PRODUCT_UPDATES = [
  'title', 'description', 'price', 'currency', 'condition',
  'category', 'type', 'kpopGroup', 'kpopMember', 'albumName',
  'group', 'member', 'album', 'version', 'era', 'pob', 'isOfficial',
  'isAvailable', 'shippingOptions', 'allowOffers'
];
const CATALOG_REFERENCE_FIELDS = ['group', 'member', 'album'] as const;
/** Paiements qui font d'un article une vente encaissée. */
const PAID_SALE_STATUSES: IPayment['status'][] = ['completed', 'partially_refunded'];

// Le prix libre (isPayWhatYouWant, pwywMinPrice, pwywMaxPrice) passe par
// POST /api/messaging/pwyw, qui valide la fourchette.
// `images` est volontairement absent : un chemin fourni par le client permettrait
// de faire supprimer n'importe quel fichier du serveur via DELETE /:id/images.

function assertValidObjectId(productId: string) {
  if (!mongoose.Types.ObjectId.isValid(productId)) {
    throw new HttpError(400, 'ID de produit invalide');
  }
}

type KpopEntity = { _id: mongoose.Types.ObjectId; name: string };

interface KpopNames {
  kpopGroupName?: string;
  kpopGroupId?: string;
  albumNameStr?: string;
  albumId?: string;
}

type EnrichedProduct = Omit<IProduct, keyof mongoose.Document> &
  KpopNames & { _id: mongoose.Types.ObjectId; shippingPrice?: number | null };

/**
 * Groupes (ou albums) désignés par les annonces, en une requête pour toute la
 * liste. Un identifiant désigne l'entité par son `_id`, sinon par son nom
 * exact ; à nom égal, la première trouvée l'emporte.
 *
 * @returns les entités indexées par l'identifiant ou le nom employé.
 */
async function loadKpopEntities(
  model: typeof KpopGroup | typeof KpopAlbum,
  identifiers: unknown[]
): Promise<Map<string, KpopEntity>> {
  const wanted = [...new Set(identifiers.filter((value): value is string => typeof value === 'string' && value !== ''))];
  const ids = new Set(wanted.filter((value) => mongoose.Types.ObjectId.isValid(value)));
  const names = new Set(wanted.filter((value) => !ids.has(value)));
  const byKey = new Map<string, KpopEntity>();
  if (!wanted.length) return byKey;

  const criteria = [
    ...(ids.size ? [{ _id: { $in: [...ids] } }] : []),
    ...(names.size ? [{ name: { $in: [...names] } }] : [])
  ];
  const entities = await (model as typeof KpopGroup).find({ $or: criteria }).select('_id name').lean<KpopEntity[]>();

  for (const entity of entities) {
    const id = entity._id.toString();
    if (ids.has(id)) byKey.set(id, entity);
    if (names.has(entity.name) && !byKey.has(entity.name)) byKey.set(entity.name, entity);
  }
  return byKey;
}

function cleanupUploadedFiles(files?: Express.Multer.File[]) {
  if (!files || !Array.isArray(files)) return;
  for (const file of files) {
    if (fs.existsSync(file.path)) {
      fs.unlinkSync(file.path);
    }
  }
}

async function withKpopNames(products: IProduct[]): Promise<EnrichedProduct[]> {
  // La référence structurée prime ; les anciennes annonces n'ont que le champ libre.
  const groupKey = (product: IProduct) => product.group?.toString() ?? product.kpopGroup;
  const albumKey = (product: IProduct) => product.album?.toString() ?? product.albumName;
  const [groups, albums] = await Promise.all([
    loadKpopEntities(KpopGroup, products.map(groupKey)),
    loadKpopEntities(KpopAlbum, products.map(albumKey))
  ]);

  return products.map((product) => {
    const enriched: EnrichedProduct = product.toObject();
    const group = groups.get(groupKey(product));
    if (group) {
      enriched.kpopGroupName = group.name;
      enriched.kpopGroupId = group._id.toString();
    }
    const albumIdentifier = albumKey(product);
    const album = albumIdentifier ? albums.get(albumIdentifier) : undefined;
    if (album) {
      enriched.albumNameStr = album.name;
      enriched.albumId = album._id.toString();
    }
    return enriched;
  });
}

async function findProductOr404(productId: string) {
  const product = await Product.findById(productId);
  if (!product) {
    throw new HttpError(404, 'Produit non trouvé');
  }
  return product;
}

function assertOwnership(product: Pick<IProduct, 'seller'>, userId: string, message: string) {
  if (product.seller.toString() !== userId) {
    throw new HttpError(403, message);
  }
}

/** Retire des compteurs la vente que `markAsSold` y avait ajoutée. */
async function revertManualSaleStatistics(sellerId: string, buyerId?: mongoose.Types.ObjectId) {
  await User.updateOne(
    { _id: sellerId, 'statistics.totalSales': { $gt: 0 } },
    { $inc: { 'statistics.totalSales': -1 } }
  );
  if (buyerId) {
    await User.updateOne(
      { _id: buyerId, 'statistics.totalPurchases': { $gt: 0 } },
      { $inc: { 'statistics.totalPurchases': -1 } }
    );
  }
}

/**
 * Chemins publics des images reçues par multer. `req.body.images` est ignoré :
 * un chemin fourni par le client finirait dans fs.unlinkSync à la suppression.
 */
export function resolveProductImages(req: Pick<Express.Request, 'files'>): string[] {
  if (!req.files || !Array.isArray(req.files)) return [];
  return (req.files as Express.Multer.File[]).map(file =>
    `/uploads/products/${path.basename(file.path)}`
  );
}

export async function createProductForSeller({
  sellerId,
  productData,
  imageUrls,
  uploadedFiles
}: {
  sellerId: string;
  productData: Record<string, unknown>;
  imageUrls: string[];
  uploadedFiles?: Express.Multer.File[];
}) {
  // Vérifier que le vendeur peut encaisser. PayPal est désormais le seul canal :
  // Stripe a été retiré de la plateforme.
  const seller = await User.findById(sellerId).select(
    'paypalConnected paypalMerchantId paypalOnboarding'
  );
  if (!seller) {
    cleanupUploadedFiles(uploadedFiles);
    throw new HttpError(404, 'Utilisateur non trouvé');
  }

  const canReceiveViaPayPal = Boolean(
    seller.paypalMerchantId &&
    seller.paypalOnboarding?.paymentsReceivable &&
    seller.paypalOnboarding?.primaryEmailConfirmed &&
    seller.paypalOnboarding?.consentGranted
  );

  if (!canReceiveViaPayPal) {
    cleanupUploadedFiles(uploadedFiles);
    throw new HttpError(
      403,
      'Vous devez connecter votre compte PayPal avant de pouvoir vendre. Rendez-vous dans Paramètres > Paiements.',
      'SELLER_PAYOUT_ACCOUNT_REQUIRED'
    );
  }

  if (imageUrls.length === 0) {
    cleanupUploadedFiles(uploadedFiles);
    throw new HttpError(400, 'Au moins une image est requise pour créer un produit');
  }

  productData.images = imageUrls;

  if (typeof productData.shippingOptions === 'string') {
    try {
      productData.shippingOptions = JSON.parse(productData.shippingOptions);
    } catch {
      throw new HttpError(400, 'shippingOptions est mal formé');
    }
  }

  const { error, value } = validateProductData(productData);
  if (error !== undefined) {
    cleanupUploadedFiles(uploadedFiles);
    throw new HttpError(400, error);
  }

  try {
    await assertCatalogConsistency(value);
  } catch (catalogError) {
    cleanupUploadedFiles(uploadedFiles);
    throw catalogError;
  }

  const product = new Product({
    ...value,
    seller: sellerId,
    isAvailable: true,
    views: 0,
    favorites: 0
  });

  await product.save();

  await User.findByIdAndUpdate(sellerId, {
    $inc: { 'statistics.totalListings': 1 }
  });

  // Modération IA (mots-clés suspects -> analyse Mistral). Fire-and-forget :
  // ne retarde jamais la publication, l'annonce est déjà visible.
  dispatchProductModeration(product._id.toString());

  // Alertes des recherches sauvegardées, après la réponse. Une annonce que la
  // modération va analyser attend son verdict : c'est elle qui les déclenche.
  if (!awaitsModerationVerdict(product)) {
    dispatchSavedSearchAlerts(product._id.toString());
  }

  return product;
}

export async function fetchProductById(productId: string, userId?: string) {
  assertValidObjectId(productId);

  const product = await Product.findById(productId)
    .populate('seller', 'username profilePicture isIdentityVerified statistics.averageRating statistics.totalRatings');

  if (!product) {
    throw new HttpError(404, 'Produit non trouvé');
  }

  const isOwner = userId === product.seller._id.toString();

  // Comme dans l'inventaire public : une annonce retirée sans avoir été vendue
  // (en pause, archivée, suspendue par la modération) ne regarde que son vendeur.
  if (!isOwner && !product.isAvailable && !product.isSold) {
    throw new HttpError(404, 'Produit non trouvé');
  }

  const [enrichedProduct] = await withKpopNames([product]);

  const opts: Partial<IProduct['shippingOptions']> = enrichedProduct.shippingOptions || {};
  enrichedProduct.shippingPrice = opts.nationalCost ?? opts.shippingCost ?? null;

  if (!isOwner) {
    // Données internes : analyse de modération et identité de l'acheteur.
    delete enrichedProduct.moderationFlag;
    delete enrichedProduct.soldTo;
  }

  if (userId && !isOwner) {
    // $inc atomique : aucune vue concurrente perdue, et pas de validation
    // complète du document à chaque consultation.
    await Product.updateOne({ _id: product._id }, { $inc: { views: 1 } });
  }

  let isFavorite = false;
  if (userId) {
    const user = await User.findById(userId, { favorites: 1 });
    if (user?.favorites?.includes(product._id)) {
      isFavorite = true;
    }
  }

  return { product: enrichedProduct, isFavorite };
}

export async function listProducts(query: Record<string, unknown>) {
  const page = queryInt(query.page) || DEFAULT_LIST_PAGE;
  const limit = clampLimit(query.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const sort = queryString(query.sort) || DEFAULT_LIST_SORT;
  if (!ALLOWED_LIST_SORTS.has(sort)) {
    throw new HttpError(400, `Tri non supporté. Valeurs acceptées : ${[...ALLOWED_LIST_SORTS].join(', ')}`);
  }

  const filter: mongoose.QueryFilter<IProduct> = { isAvailable: true };

  const seller = queryString(query.seller);
  const type = queryString(query.type);
  const kpopGroup = queryString(query.kpopGroup);
  const kpopMember = queryString(query.kpopMember);
  if (seller) filter.seller = seller;
  if (type) filter.type = type as IProduct['type'];
  if (kpopGroup) filter.kpopGroup = kpopGroup;
  if (kpopMember) filter.kpopMember = kpopMember;

  const minPrice = parseFloat(queryString(query.minPrice) ?? '');
  const maxPrice = parseFloat(queryString(query.maxPrice) ?? '');
  if (!isNaN(minPrice) || !isNaN(maxPrice)) {
    const price: { $gte?: number; $lte?: number } = {};
    filter.price = price;
    if (!isNaN(minPrice)) price.$gte = minPrice;
    if (!isNaN(maxPrice)) price.$lte = maxPrice;
  }

  const condition = queryString(query.condition);
  if (condition) {
    filter.condition = { $in: condition.split(',') as IProduct['condition'][] };
  }

  const search = queryString(query.search);
  if (search) {
    filter.$text = { $search: search };
  }

  const catalogClauses = await buildCatalogClauses(parseCatalogCriteria(query));
  if (catalogClauses.length) filter.$and = [...(filter.$and ?? []), ...catalogClauses];

  const [products, total] = await Promise.all([
    Product.find(filter)
      .populate('seller', 'username profilePicture isIdentityVerified')
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(limit),
    Product.countDocuments(filter)
  ]);

  return {
    products: await withKpopNames(products),
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit)
    }
  };
}

export async function updateProductForOwner({
  productId,
  userId,
  body
}: {
  productId: string;
  userId: string;
  body: Record<string, unknown>;
}) {
  assertValidObjectId(productId);

  const product = await findProductOr404(productId);
  assertOwnership(product, userId, 'Vous n\'êtes pas autorisé à modifier ce produit');

  const allowedUpdates: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (ALLOWED_PRODUCT_UPDATES.includes(key)) {
      allowedUpdates[key] = value;
    }
  }

  // Mêmes règles qu'à la création : sinon un PUT contournait la validation
  // (titre vide, prix négatif, état inconnu…).
  const { error, value: updates } = validateProductUpdate(allowedUpdates);
  if (error !== undefined) {
    throw new HttpError(400, error);
  }

  // Un champ absent de la mise à jour garde sa valeur : la cohérence se juge
  // sur l'annonce telle qu'elle sera après écriture.
  if (CATALOG_REFERENCE_FIELDS.some((field) => field in updates)) {
    await assertCatalogConsistency({
      group: 'group' in updates ? updates.group : product.group?.toString(),
      member: 'member' in updates ? updates.member : product.member,
      album: 'album' in updates ? updates.album : product.album?.toString()
    });
  }

  // Une annonce mise en pause par la modération IA et pas encore validée par
  // un admin ne peut pas être republiée par le vendeur lui-même : seul
  // `reviewFlaggedProduct` (revue admin) peut lever la pause.
  if (
    updates.isAvailable === true &&
    product.moderationFlag?.suspect &&
    product.moderationFlag.reviewDecision !== 'approved'
  ) {
    throw new HttpError(403, 'Cette annonce est en attente de revue par un administrateur et ne peut pas être republiée');
  }

  // Remettre en vente un article vendu annule la vente. Seule une vente
  // déclarée à la main peut l'être : une vente payée ne se défait que par un
  // remboursement total, qui remet lui-même l'annonce en vente.
  const cancelsSale = updates.isAvailable === true && product.isSold;
  if (cancelsSale && await Payment.exists({ product: product._id, status: { $in: PAID_SALE_STATUSES } })) {
    throw new HttpError(409, 'Cet article a été payé via la plateforme : remboursez l\'acheteur pour le remettre en vente');
  }

  const previousPrice = product.price;
  const previousAvailable = product.isAvailable;

  const updated = await Product.findByIdAndUpdate(
    productId,
    cancelsSale
      ? { $set: { ...updates, isSold: false }, $unset: { soldAt: 1, soldTo: 1 } }
      : { $set: updates },
    { returnDocument: 'after', runValidators: true }
  );

  if (updated && cancelsSale) {
    await revertManualSaleStatistics(userId, product.soldTo);
  }

  if (updated) {
    if (
      typeof updates.price === 'number' &&
      updates.price < previousPrice
    ) {
      notifyWishlistPriceDrop(updated, previousPrice, updates.price)
        .catch(() => { /* déjà loggué dans le service */ });
    }
    if (updates.isAvailable === false && previousAvailable !== false) {
      notifyWishlistUnavailable(updated, 'unavailable')
        .catch(() => { /* déjà loggué dans le service */ });
    }
  }

  return updated;
}

export async function removeProduct({
  productId,
  userId,
  soft
}: {
  productId: string;
  userId: string;
  soft: boolean;
}): Promise<{ soft: boolean }> {
  assertValidObjectId(productId);

  const product = await findProductOr404(productId);
  assertOwnership(product, userId, 'Vous n\'êtes pas autorisé à supprimer ce produit');

  if (soft) {
    product.isAvailable = false;
    await product.save();
    notifyWishlistUnavailable(product, 'unavailable')
      .catch(() => { /* déjà loggué dans le service */ });
    return { soft: true };
  }

  notifyWishlistUnavailable(product, 'unavailable')
    .catch(() => { /* déjà loggué dans le service */ });
  await product.deleteOne();
  return { soft: false };
}

export async function markAsSold({
  productId,
  userId,
  buyerId
}: {
  productId: string;
  userId: string;
  buyerId?: string;
}) {
  assertValidObjectId(productId);

  const product = await findProductOr404(productId);
  assertOwnership(product, userId, 'Vous n\'êtes pas autorisé à modifier ce produit');

  // Le front transmet l'identifiant du vendeur lui-même quand il ne connaît pas
  // l'acheteur : la vente est alors enregistrée sans acheteur.
  const declaredBuyerId = buyerId && buyerId !== userId ? buyerId : undefined;
  // Le corps JSON n'est pas typé : un tableau ou un objet ne passe pas.
  if (declaredBuyerId && (typeof declaredBuyerId !== 'string' || !mongoose.Types.ObjectId.isValid(declaredBuyerId))) {
    throw new HttpError(400, 'ID d\'acheteur invalide');
  }
  // Un identifiant fantôme fausserait `soldTo` (avis, litiges) sans compter d'achat à personne.
  if (declaredBuyerId && !(await User.exists({ _id: declaredBuyerId, accountStatus: { $ne: 'deleted' } }))) {
    throw new HttpError(400, 'Acheteur introuvable');
  }
  // Sinon chaque clic compterait une vente de plus dans les statistiques.
  if (product.isSold) {
    throw new HttpError(409, 'Cet article est déjà marqué comme vendu');
  }

  // Comme une vente payée : isSold distingue une annonce vendue d'une annonce
  // simplement retirée ou mise en pause par la modération.
  product.isAvailable = false;
  product.isSold = true;
  product.soldAt = new Date();

  // Un vendeur n'est jamais son propre acheteur : ses achats ne doivent pas en être gonflés.
  if (declaredBuyerId) {
    product.soldTo = new mongoose.Types.ObjectId(declaredBuyerId);
    await User.findByIdAndUpdate(declaredBuyerId, {
      $inc: { 'statistics.totalPurchases': 1 }
    });
  }

  await User.findByIdAndUpdate(userId, {
    $inc: { 'statistics.totalSales': 1 }
  });

  await product.save();

  notifyWishlistUnavailable(product, 'sold')
    .catch(() => { /* déjà loggué dans le service */ });

  return product;
}

export async function toggleFavoriteForUser(userId: string, productId: string): Promise<boolean> {
  assertValidObjectId(productId);

  const product = await findProductOr404(productId);

  const user = await User.findById(userId);
  if (!user) {
    throw new HttpError(404, 'Utilisateur non trouvé');
  }

  if (!user.favorites) {
    user.favorites = [];
  }

  const favoriteIndex = user.favorites.indexOf(product._id);
  let isFavorite: boolean;

  if (favoriteIndex === -1) {
    user.favorites.push(product._id);
    product.favorites += 1;
    isFavorite = true;
  } else {
    user.favorites.splice(favoriteIndex, 1);
    product.favorites = Math.max(0, product.favorites - 1);
    isFavorite = false;
  }

  await Promise.all([user.save(), product.save()]);

  return isFavorite;
}
