import mongoose from 'mongoose';
import path from 'path';
import fs from 'fs';
import Product, { IProduct } from '../../../models/productModel';
import User from '../../../models/userModel';
import KpopGroup from '../../../models/kpopGroupModel';
import KpopAlbum from '../../../models/albumModel';
import { HttpError } from '../../../commons/utils/httpError';
import { clampLimit } from '../../../commons/utils/pagination';
import { validateProductData } from './productValidationService';
import { notifyWishlistPriceDrop, notifyWishlistUnavailable } from './wishlistAlertService';
import { dispatchProductModeration } from './productModerationService';

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 500;
const DEFAULT_LIST_PAGE = 1;
const DEFAULT_LIST_SORT = '-createdAt';

const ALLOWED_PRODUCT_UPDATES = [
  'title', 'description', 'price', 'currency', 'condition',
  'category', 'kpopGroup', 'kpopMember', 'albumName',
  'isAvailable', 'isReserved', 'reservedFor', 'shippingOptions'
];
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
  const [groups, albums] = await Promise.all([
    loadKpopEntities(KpopGroup, products.map((product) => product.kpopGroup)),
    loadKpopEntities(KpopAlbum, products.map((product) => product.albumName))
  ]);

  return products.map((product) => {
    const enriched: EnrichedProduct = product.toObject();
    const group = groups.get(product.kpopGroup);
    if (group) {
      enriched.kpopGroupName = group.name;
      enriched.kpopGroupId = group._id.toString();
    }
    const album = product.albumName ? albums.get(product.albumName) : undefined;
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
    } catch (e) {
      throw new HttpError(400, 'shippingOptions est mal formé');
    }
  }

  const { error, value } = validateProductData(productData);
  if (error) {
    cleanupUploadedFiles(uploadedFiles);
    throw new HttpError(400, error.details[0].message);
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

  return product;
}

export async function fetchProductById(productId: string, userId?: string) {
  assertValidObjectId(productId);

  const product = await Product.findById(productId)
    .populate('seller', 'username profilePicture isIdentityVerified statistics.averageRating statistics.totalRatings');

  if (!product) {
    throw new HttpError(404, 'Produit non trouvé');
  }

  const [enrichedProduct] = await withKpopNames([product]);

  const opts: Partial<IProduct['shippingOptions']> = enrichedProduct.shippingOptions || {};
  enrichedProduct.shippingPrice = opts.nationalCost ?? opts.shippingCost ?? null;

  if (userId && userId !== product.seller._id.toString()) {
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
  const page = parseInt(query.page as string) || DEFAULT_LIST_PAGE;
  const limit = clampLimit(query.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const sort = query.sort || DEFAULT_LIST_SORT;

  const filter: mongoose.QueryFilter<IProduct> = { isAvailable: true };

  if (query.seller) filter.seller = query.seller as string;
  if (query.type) filter.type = query.type as IProduct['type'];
  if (query.kpopGroup) filter.kpopGroup = query.kpopGroup as string;
  if (query.kpopMember) filter.kpopMember = query.kpopMember as string;

  if (query.minPrice || query.maxPrice) {
    const price: { $gte?: number; $lte?: number } = {};
    filter.price = price;
    if (query.minPrice) price.$gte = parseFloat(query.minPrice as string);
    if (query.maxPrice) price.$lte = parseFloat(query.maxPrice as string);
  }

  if (query.condition) {
    const conditions = (query.condition as string).split(',');
    if (conditions.length > 0) {
      filter.condition = { $in: conditions as IProduct['condition'][] };
    }
  }

  if (query.search) {
    filter.$text = { $search: query.search as string };
  }

  const [products, total] = await Promise.all([
    Product.find(filter)
      .populate('seller', 'username profilePicture isIdentityVerified')
      .sort(sort as string)
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

  const updates: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (ALLOWED_PRODUCT_UPDATES.includes(key)) {
      updates[key] = value;
    }
  }

  if (updates.isReserved && updates.reservedFor) {
    const userExists = await User.exists({ _id: updates.reservedFor });
    if (!userExists) {
      throw new HttpError(400, 'Utilisateur réservé invalide');
    }
  } else if (updates.isReserved === false) {
    updates.reservedFor = null;
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

  const previousPrice = product.price;
  const previousAvailable = product.isAvailable;

  const updated = await Product.findByIdAndUpdate(
    productId,
    { $set: updates },
    { new: true, runValidators: true }
  );

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

  if (buyerId && !mongoose.Types.ObjectId.isValid(buyerId)) {
    throw new HttpError(400, 'ID d\'acheteur invalide');
  }

  product.isAvailable = false;

  if (buyerId) {
    await User.findByIdAndUpdate(buyerId, {
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
  let isFavorite = false;

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
