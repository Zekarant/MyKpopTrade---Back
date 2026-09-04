import mongoose from 'mongoose';
import path from 'path';
import fs from 'fs';
import Product from '../../../models/productModel';
import User from '../../../models/userModel';
import KpopGroup from '../../../models/kpopGroupModel';
import KpopAlbum from '../../../models/albumModel';
import { HttpError } from '../../../commons/utils/httpError';
import { validateProductData } from './productValidationService';
import { notifyWishlistPriceDrop, notifyWishlistUnavailable } from './wishlistAlertService';

const DEFAULT_LIST_LIMIT = 20;
const DEFAULT_LIST_PAGE = 1;
const DEFAULT_LIST_SORT = '-createdAt';

const ALLOWED_PRODUCT_UPDATES = [
  'title', 'description', 'price', 'currency', 'condition',
  'category', 'kpopGroup', 'kpopMember', 'albumName',
  'images', 'isAvailable', 'isReserved', 'reservedFor', 'shippingOptions'
];

function assertValidObjectId(productId: string) {
  if (!mongoose.Types.ObjectId.isValid(productId)) {
    throw new HttpError(400, 'ID de produit invalide');
  }
}

async function findKpopEntityByIdOrName<T extends { _id: any; name: string }>(
  model: { findById: Function; findOne: Function },
  identifier: string
): Promise<T | null> {
  return mongoose.Types.ObjectId.isValid(identifier)
    ? await model.findById(identifier).select('_id name')
    : await model.findOne({ name: identifier }).select('_id name');
}

function cleanupUploadedFiles(files?: Express.Multer.File[]) {
  if (!files || !Array.isArray(files)) return;
  for (const file of files) {
    if (fs.existsSync(file.path)) {
      fs.unlinkSync(file.path);
    }
  }
}

async function enrichWithKpopNames(product: any, enriched: any) {
  if (product.kpopGroup) {
    const group = await findKpopEntityByIdOrName<any>(KpopGroup, product.kpopGroup);
    if (group) {
      enriched.kpopGroupName = group.name;
      enriched.kpopGroupId = group._id.toString();
    }
  }

  if (product.albumName) {
    const album = await findKpopEntityByIdOrName<any>(KpopAlbum, product.albumName);
    if (album) {
      enriched.albumNameStr = album.name;
      enriched.albumId = album._id.toString();
    }
  }
}

async function findProductOr404(productId: string) {
  const product = await Product.findById(productId);
  if (!product) {
    throw new HttpError(404, 'Produit non trouvé');
  }
  return product;
}

function assertOwnership(product: any, userId: string, message: string) {
  if (product.seller.toString() !== userId) {
    throw new HttpError(403, message);
  }
}

export function resolveProductImages(req: {
  files?: any;
  body: any;
}): string[] {
  let imageUrls: string[] = [];

  if (req.files && Array.isArray(req.files) && req.files.length > 0) {
    imageUrls = (req.files as Express.Multer.File[]).map(file =>
      `/uploads/products/${path.basename(file.path)}`
    );
  }

  const productData = req.body;
  if (productData.images && Array.isArray(productData.images) && productData.images.length > 0) {
    if (typeof productData.images === 'string') {
      try {
        const parsedImages = JSON.parse(productData.images);
        if (Array.isArray(parsedImages)) {
          imageUrls = [...imageUrls, ...parsedImages];
        }
      } catch (e) {
        imageUrls.push(productData.images);
      }
    } else {
      imageUrls = [...imageUrls, ...productData.images];
    }
  }

  return imageUrls;
}

export async function createProductForSeller({
  sellerId,
  productData,
  imageUrls,
  uploadedFiles
}: {
  sellerId: string;
  productData: any;
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

  return product;
}

export async function fetchProductById(productId: string, userId?: string) {
  assertValidObjectId(productId);

  const product = await Product.findById(productId)
    .populate('seller', 'username profilePicture isIdentityVerified statistics.averageRating statistics.totalRatings');

  if (!product) {
    throw new HttpError(404, 'Produit non trouvé');
  }

  const enrichedProduct: any = product.toObject();

  await enrichWithKpopNames(product, enrichedProduct);

  const opts = enrichedProduct.shippingOptions || {};
  enrichedProduct.shippingPrice = opts.nationalCost ?? opts.shippingCost ?? null;

  if (userId && userId !== product.seller._id.toString()) {
    product.views += 1;
    await product.save();
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

export async function listProducts(query: any) {
  const page = parseInt(query.page as string) || DEFAULT_LIST_PAGE;
  const limit = parseInt(query.limit as string) || DEFAULT_LIST_LIMIT;
  const sort = query.sort || DEFAULT_LIST_SORT;

  const filter: any = { isAvailable: true };

  if (query.seller) filter.seller = query.seller;
  if (query.type) filter.type = query.type;
  if (query.kpopGroup) filter.kpopGroup = query.kpopGroup;
  if (query.kpopMember) filter.kpopMember = query.kpopMember;

  if (query.minPrice || query.maxPrice) {
    filter.price = {};
    if (query.minPrice) filter.price.$gte = parseFloat(query.minPrice as string);
    if (query.maxPrice) filter.price.$lte = parseFloat(query.maxPrice as string);
  }

  if (query.condition) {
    const conditions = (query.condition as string).split(',');
    if (conditions.length > 0) {
      filter.condition = { $in: conditions };
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

  const enrichedProducts = await Promise.all(
    products.map(async (product) => {
      const enrichedProduct: any = product.toObject();
      await enrichWithKpopNames(product, enrichedProduct);
      return enrichedProduct;
    })
  );

  return {
    products: enrichedProducts,
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
  body: Record<string, any>;
}) {
  assertValidObjectId(productId);

  const product = await findProductOr404(productId);
  assertOwnership(product, userId, 'Vous n\'êtes pas autorisé à modifier ce produit');

  const updates: Record<string, any> = {};
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
