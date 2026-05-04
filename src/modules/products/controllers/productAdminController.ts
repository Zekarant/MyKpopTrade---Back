import { Request, Response } from 'express';
import Product from '../../../models/productModel';
import { asyncHandler } from '../../../commons/middlewares/errorMiddleware';

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

  const product = await Product.findByIdAndDelete(productId);
  if (!product) {
    return res.status(404).json({ message: 'Produit non trouvé' });
  }

  return res.status(200).json({ message: 'Produit supprimé par l\'administrateur' });
});
