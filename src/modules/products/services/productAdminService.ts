import mongoose from 'mongoose';
import Product, { IProduct } from '../../../models/productModel';
import { IUser } from '../../../models/userModel';
import { recordAuditLog } from '../../../commons/utils/auditService';
import { dispatchAdminAlert } from '../../../commons/services/adminAlertService';
import { buildCsvFile, CSV_EXPORT_ROW_LIMIT, CsvFile } from '../../../commons/utils/csv';
import { badRequest, notFound } from '../../../commons/utils/httpError';
import { PageRequest, paginationMeta } from '../../../commons/utils/pagination';
import { escapeRegex } from '../../../commons/utils/escapeRegex';
import { createNotification } from '../../notifications/services/notificationService';
import { dispatchSavedSearchAlerts } from '../../savedSearches/services/savedSearchAlertService';

const PRODUCT_TYPES: readonly IProduct['type'][] = ['photocard', 'album', 'merch', 'other'];
const NEW_PRODUCTS_WINDOW_DAYS = 7;
const RECENT_SALES_WINDOW_DAYS = 30;

/** Filtres de la liste admin des annonces. */
export interface AdminProductFilters {
  search?: string;
  status?: string;
  type?: string;
}

const productNotFound = () => notFound('Produit non trouvé');

const productStatusLabel = (
  product: Pick<IProduct, 'isSold' | 'isAvailable' | 'moderationFlag'>
): string => {
  if (product.isSold) return 'vendu';
  if (!product.isAvailable && product.moderationFlag?.suspect) return 'suspendu';
  return product.isAvailable ? 'disponible' : 'indisponible';
};

function buildAdminProductFilter({ search, status, type }: AdminProductFilters): mongoose.QueryFilter<IProduct> {
  const filter: mongoose.QueryFilter<IProduct> = {};

  if (search) {
    const pattern = escapeRegex(search);
    filter.$or = [
      { title: { $regex: pattern, $options: 'i' } },
      { description: { $regex: pattern, $options: 'i' } }
    ];
  }

  if (status === 'available') filter.isAvailable = true;
  if (status === 'sold') filter.isSold = true;
  if (status === 'suspended') {
    filter.isAvailable = false;
    filter['moderationFlag.suspect'] = true;
  }

  if (type && PRODUCT_TYPES.includes(type as IProduct['type'])) {
    filter.type = type as IProduct['type'];
  }

  return filter;
}

/** Page de la liste admin des annonces, les plus récentes d'abord. */
export async function listAdminProducts(filters: AdminProductFilters, pageRequest: PageRequest) {
  const filter = buildAdminProductFilter(filters);
  const [products, total] = await Promise.all([
    Product.find(filter)
      .populate('seller', 'username profilePicture')
      .sort({ createdAt: -1 })
      .skip(pageRequest.skip)
      .limit(pageRequest.limit)
      .lean(),
    Product.countDocuments(filter)
  ]);

  return { products, pagination: paginationMeta(pageRequest, total) };
}

/** Export CSV de la liste admin (CSV_EXPORT_ROW_LIMIT lignes au plus). */
export async function exportAdminProducts(filters: AdminProductFilters): Promise<CsvFile> {
  const rows = await Product.find(buildAdminProductFilter(filters))
    .populate<{ seller: Pick<IUser, 'username' | 'email'> | null }>('seller', 'username email')
    .sort({ createdAt: -1 })
    .limit(CSV_EXPORT_ROW_LIMIT)
    .lean();

  return buildCsvFile('produits', rows, [
    { header: 'Titre', value: (p) => p.title },
    { header: 'Vendeur', value: (p) => p.seller?.username },
    { header: 'Email vendeur', value: (p) => p.seller?.email },
    { header: 'Prix', value: (p) => p.price },
    { header: 'Devise', value: (p) => p.currency },
    { header: 'Type', value: (p) => p.type },
    { header: 'État', value: (p) => p.condition },
    { header: 'Statut', value: productStatusLabel },
    { header: 'Créé le', value: (p) => p.createdAt },
    { header: 'Vendu le', value: (p) => p.soldAt }
  ]);
}

const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

/** Statistiques des annonces pour le tableau de bord admin. */
export async function getProductAdminStats() {
  const [total, available, sold, suspended, newProducts, recentSales, typeDistribution, revenueResult] =
    await Promise.all([
      Product.countDocuments({}),
      Product.countDocuments({ isAvailable: true }),
      Product.countDocuments({ isSold: true }),
      Product.countDocuments({ isAvailable: false, 'moderationFlag.suspect': true }),
      Product.countDocuments({ createdAt: { $gte: daysAgo(NEW_PRODUCTS_WINDOW_DAYS) } }),
      Product.countDocuments({ isSold: true, soldAt: { $gte: daysAgo(RECENT_SALES_WINDOW_DAYS) } }),
      Product.aggregate<{ _id: string | null; count: number }>([
        { $group: { _id: '$type', count: { $sum: 1 } } }
      ]),
      // Revenu total : somme des prix des annonces vendues.
      Product.aggregate<{ _id: null; total: number }>([
        { $match: { isSold: true } },
        { $group: { _id: null, total: { $sum: '$price' } } }
      ])
    ]);

  return {
    total,
    available,
    sold,
    suspended,
    newProducts,
    recentSales,
    totalRevenue: revenueResult[0]?.total || 0,
    typeDistribution: typeDistribution.reduce((acc: Record<string, number>, item) => {
      acc[item._id || 'unknown'] = item.count;
      return acc;
    }, {})
  };
}

/**
 * Supprime une annonce (admin), avec journal d'audit et alerte admin.
 *
 * @throws HttpError 404 si l'annonce n'existe pas.
 */
export async function deleteProductAsAdmin({
  productId,
  adminId,
  reason
}: {
  productId: string;
  adminId: string;
  reason?: string;
}): Promise<void> {
  const product = await Product.findByIdAndDelete(productId)
    .populate<{ seller: Pick<IUser, 'username'> | null }>('seller', 'username')
    .lean();
  if (!product) throw productNotFound();

  await recordAuditLog({
    adminId,
    action: 'delete_product',
    targetType: 'product',
    targetId: productId,
    details: `Produit « ${product.title} » supprimé${reason ? ` — ${reason}` : ''}`,
    metadata: { price: product.price, currency: product.currency, seller: product.seller?.username }
  });

  dispatchAdminAlert({
    event: 'product.deleted',
    severity: 'info',
    title: 'Produit supprimé par un administrateur',
    summary: `« ${product.title} »${reason ? ` — ${reason}` : ''}`,
    adminTab: 'products',
    fields: [
      { name: 'Vendeur', value: product.seller?.username || 'inconnu', inline: true },
      { name: 'Prix', value: `${product.price} ${product.currency}`, inline: true }
    ],
    data: { productId, reason }
  });
}

/**
 * Revue admin d'une annonce mise en pause par la modération IA.
 *  - approve: true  -> réannonce (isAvailable = true), l'annonce redevient visible.
 *  - approve: false -> confirme le signalement, l'annonce reste en pause
 *    (à supprimer via DELETE /admin/:productId si besoin).
 *
 * @throws HttpError 404 si l'annonce n'existe pas, 400 si elle n'a pas d'analyse de modération.
 */
export async function reviewFlaggedProduct({
  productId,
  adminId,
  approve
}: {
  productId: string;
  adminId: string;
  approve: boolean;
}) {
  const product = await Product.findById(productId);
  if (!product) throw productNotFound();
  if (!product.moderationFlag) {
    throw badRequest('Ce produit n\'a pas d\'analyse de modération à revoir', 'NO_MODERATION_FLAG');
  }

  product.moderationFlag.reviewedBy = new mongoose.Types.ObjectId(adminId);
  product.moderationFlag.reviewedAt = new Date();
  product.moderationFlag.reviewDecision = approve ? 'approved' : 'rejected';
  // Seule une annonce retenue par la modération devient visible ici : ses
  // alertes de recherches sauvegardées avaient été différées jusqu'à la revue.
  const isRepublished = approve && !product.isAvailable && !product.isSold;
  if (approve) {
    product.isAvailable = true;
  }
  await product.save();
  if (isRepublished) {
    dispatchSavedSearchAlerts(productId);
  }

  await recordAuditLog({
    adminId,
    action: approve ? 'product_moderation_approved' : 'product_moderation_rejected',
    targetType: 'product',
    targetId: productId,
    details: `Annonce « ${product.title} » ${approve ? 'validée et republiée' : 'confirmée suspecte, reste en pause'}`,
    metadata: { categories: product.moderationFlag.categories }
  });

  if (approve) {
    void createNotification({
      recipientId: product.seller,
      type: 'product_flagged',
      title: 'Votre annonce a été validée',
      content: `« ${product.title} » est de nouveau visible sur la marketplace.`,
      link: `/products/${product._id}`,
      data: { productId: product._id }
    });
  }

  return product;
}
