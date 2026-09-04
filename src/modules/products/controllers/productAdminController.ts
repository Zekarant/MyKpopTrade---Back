import { Request, Response } from 'express';
import Product from '../../../models/productModel';
import { asyncHandler } from '../../../commons/middlewares/errorMiddleware';
import { recordAuditLog } from '../../../commons/utils/auditService';
import { dispatchAdminAlert } from '../../../commons/services/adminAlertService';
import { CSV_EXPORT_ROW_LIMIT, sendCsvDownload, wantsCsv } from '../../../commons/utils/csv';

const productStatusLabel = (product: any): string => {
  if (product.isSold) return 'vendu';
  if (product.isReserved) return 'réservé';
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
  const [total, available, sold, reserved] = await Promise.all([
    Product.countDocuments({}),
    Product.countDocuments({ isAvailable: true }),
    Product.countDocuments({ isSold: true }),
    Product.countDocuments({ isReserved: true })
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
