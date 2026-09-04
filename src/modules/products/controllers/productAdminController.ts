import { Request, Response } from 'express';
import Product from '../../../models/productModel';
import { asyncHandler } from '../../../commons/middlewares/errorMiddleware';
import { recordAuditLog } from '../../../commons/utils/auditService';
import { dispatchAdminAlert } from '../../../commons/services/adminAlertService';
import { CSV_EXPORT_ROW_LIMIT, sendCsvDownload, wantsCsv } from '../../../commons/utils/csv';
import { NotificationService } from '../../notifications/services/notificationService';
import logger from '../../../commons/utils/logger';

const productStatusLabel = (product: any): string => {
  if (product.isSold) return 'vendu';
  if (product.isReserved) return 'réservé';
  if (!product.isAvailable && product.moderationFlag?.suspect) return 'suspendu';
  return product.isAvailable ? 'disponible' : 'indisponible';
};

/**
 * Liste tous les produits avec pagination et filtrage (admin)
 */
export const getAllProducts = asyncHandler(async (req: Request, res: Response) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;
  const search = req.query.search as string;
  const status = req.query.status as string;
  const type = req.query.type as string;

  const filter: any = {};

  if (search) {
    filter.$or = [
      { title: { $regex: search, $options: 'i' } },
      { description: { $regex: search, $options: 'i' } }
    ];
  }

  if (status === 'available') filter.isAvailable = true;
  if (status === 'sold') filter.isSold = true;
  if (status === 'reserved') filter.isReserved = true;
  if (status === 'suspended') {
    filter.isAvailable = false;
    filter['moderationFlag.suspect'] = true;
  }

  if (type && ['photocard', 'album', 'merch', 'other'].includes(type)) {
    filter.type = type;
  }

  if (wantsCsv(req.query.format)) {
    const rows = await Product.find(filter)
      .populate('seller', 'username email')
      .sort({ createdAt: -1 })
      .limit(CSV_EXPORT_ROW_LIMIT);

    return sendCsvDownload(res, 'produits', rows, [
      { header: 'Titre', value: (p: any) => p.title },
      { header: 'Vendeur', value: (p: any) => p.seller?.username },
      { header: 'Email vendeur', value: (p: any) => p.seller?.email },
      { header: 'Prix', value: (p: any) => p.price },
      { header: 'Devise', value: (p: any) => p.currency },
      { header: 'Type', value: (p: any) => p.type },
      { header: 'État', value: (p: any) => p.condition },
      { header: 'Statut', value: productStatusLabel },
      { header: 'Créé le', value: (p: any) => p.createdAt },
      { header: 'Vendu le', value: (p: any) => p.soldAt }
    ]);
  }

  const [products, count] = await Promise.all([
    Product.find(filter)
      .populate('seller', 'username profilePicture')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Product.countDocuments(filter)
  ]);

  return res.status(200).json({
    products,
    pagination: {
      page,
      limit,
      totalItems: count,
      totalPages: Math.ceil(count / limit)
    }
  });
});

/**
 * Statistiques produits pour l'admin
 */
export const getProductAdminStats = asyncHandler(async (req: Request, res: Response) => {
  const [total, available, sold, reserved, suspended] = await Promise.all([
    Product.countDocuments({}),
    Product.countDocuments({ isAvailable: true }),
    Product.countDocuments({ isSold: true }),
    Product.countDocuments({ isReserved: true }),
    Product.countDocuments({ isAvailable: false, 'moderationFlag.suspect': true })
  ]);

  // Produits créés dans les 7 derniers jours
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const newProducts = await Product.countDocuments({ createdAt: { $gte: sevenDaysAgo } });

  // Répartition par type
  const typeDistribution = await Product.aggregate([
    { $group: { _id: '$type', count: { $sum: 1 } } }
  ]);

  // Produits vendus dans les 30 derniers jours
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const recentSales = await Product.countDocuments({ isSold: true, soldAt: { $gte: thirtyDaysAgo } });

  // Revenu total (somme des prix des produits vendus)
  const revenueResult = await Product.aggregate([
    { $match: { isSold: true } },
    { $group: { _id: null, total: { $sum: '$price' } } }
  ]);
  const totalRevenue = revenueResult[0]?.total || 0;

  return res.status(200).json({
    total,
    available,
    sold,
    reserved,
    suspended,
    newProducts,
    recentSales,
    totalRevenue,
    typeDistribution: typeDistribution.reduce((acc: any, item: any) => {
      acc[item._id || 'unknown'] = item.count;
      return acc;
    }, {})
  });
});

/**
 * Supprimer un produit (admin)
 */
export const adminDeleteProduct = asyncHandler(async (req: Request, res: Response) => {
  const productId = req.params.productId as string;
  const adminId = (req as any).user.id;
  const { reason } = req.body ?? {};

  const product = await Product.findByIdAndDelete(productId).populate('seller', 'username');
  if (!product) {
    return res.status(404).json({ message: 'Produit non trouvé' });
  }

  await recordAuditLog({
    adminId,
    action: 'delete_product',
    targetType: 'product',
    targetId: productId,
    details: `Produit « ${product.title} » supprimé${reason ? ` — ${reason}` : ''}`,
    metadata: { price: product.price, currency: product.currency, seller: (product.seller as any)?.username }
  });

  dispatchAdminAlert({
    event: 'product.deleted',
    severity: 'info',
    title: 'Produit supprimé par un administrateur',
    summary: `« ${product.title} »${reason ? ` — ${reason}` : ''}`,
    adminTab: 'products',
    fields: [
      { name: 'Vendeur', value: (product.seller as any)?.username || 'inconnu', inline: true },
      { name: 'Prix', value: `${product.price} ${product.currency}`, inline: true }
    ],
    data: { productId, reason }
  });

  return res.status(200).json({ message: 'Produit supprimé par l\'administrateur' });
});

/**
 * Revue admin d'une annonce mise en pause par la modération IA.
 *  - approve: true  -> réannonce (isAvailable = true), l'annonce redevient visible.
 *  - approve: false -> confirme le signalement, l'annonce reste en pause
 *    (à supprimer via DELETE /admin/:productId si besoin).
 */
export const reviewFlaggedProduct = asyncHandler(async (req: Request, res: Response) => {
  const productId = req.params.productId as string;
  const adminId = (req as any).user.id;
  const { approve } = req.body ?? {};

  if (typeof approve !== 'boolean') {
    return res.status(400).json({ message: 'approve (booléen) est requis' });
  }

  const product = await Product.findById(productId);
  if (!product) {
    return res.status(404).json({ message: 'Produit non trouvé' });
  }
  if (!product.moderationFlag) {
    return res.status(400).json({ message: 'Ce produit n\'a pas d\'analyse de modération à revoir' });
  }

  product.moderationFlag.reviewedBy = adminId;
  product.moderationFlag.reviewedAt = new Date();
  product.moderationFlag.reviewDecision = approve ? 'approved' : 'rejected';
  if (approve) {
    product.isAvailable = true;
  }
  await product.save();

  await recordAuditLog({
    adminId,
    action: approve ? 'product_moderation_approved' : 'product_moderation_rejected',
    targetType: 'product',
    targetId: productId,
    details: `Annonce « ${product.title} » ${approve ? 'validée et republiée' : 'confirmée suspecte, reste en pause'}`,
    metadata: { categories: product.moderationFlag.categories }
  });

  if (approve) {
    NotificationService.createNotification({
      recipientId: product.seller,
      type: 'product_flagged',
      title: 'Votre annonce a été validée',
      content: `« ${product.title} » est de nouveau visible sur la marketplace.`,
      link: `/products/${product._id}`,
      data: { productId: product._id }
    }).catch((error) => {
      logger.warn('Erreur notification vendeur (annonce republiée)', {
        productId: product._id,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }

  return res.status(200).json({
    message: approve ? 'Annonce republiée' : 'Signalement confirmé, annonce toujours en pause',
    product
  });
});
