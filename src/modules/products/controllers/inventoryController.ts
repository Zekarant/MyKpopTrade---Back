import { Request, Response } from 'express';
import Product from '../../../models/productModel';
import User from '../../../models/userModel';
import { asyncHandler } from '../../../commons/middlewares/errorMiddleware';

/**
 * Récupérer l'inventaire d'un utilisateur (produits en vente)
 */
export const getUserInventory = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.params.userId || (req.user as any).id;
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;
  const status = req.query.status || 'available';
  
  // Construire le filtre en fonction du statut demandé
  let filter: any = { seller: userId };
  
  switch(status) {
    case 'available':
      filter.isAvailable = true;
      break;
    case 'sold':
      filter.isAvailable = false;
      break;
    case 'reserved':
      filter.isAvailable = true;
      filter.isReserved = true;
      break;
    case 'all':
      // Pas de filtre supplémentaire
      break;
    default:
      filter.isAvailable = true;
  }
  
  // Exécuter la requête avec pagination
  const [products, total] = await Promise.all([
    Product.find(filter)
      .sort('-createdAt')
      .skip((page - 1) * limit)
      .limit(limit),
    Product.countDocuments(filter)
  ]);
  
  // Si c'est le propriétaire qui consulte, ajouter des stats supplémentaires
  let inventoryStats = null;
  if (userId === (req.user as any)?.id) {
    inventoryStats = await Product.aggregate([
      { $match: { seller: userId } },
      { $group: {
        _id: null,
        totalProducts: { $sum: 1 },
        //availableProducts: { $sum: { $cond: [{ $eq: ['$isAvailable', true] }, 1, 0] } },
        soldProducts: { $sum: { $cond: [{ $eq: ['$isAvailable', false] }, 1, 0] } },
        reservedProducts: { 
          $sum: { 
            $cond: [
              { $and: [
                { $eq: ['$isAvailable', true] },
                { $eq: ['$isReserved', true] }
              ]}, 
              1, 
              0
            ] 
          } 
        },
        totalViews: { $sum: '$views' },
        totalFavorites: { $sum: '$favorites' }
      }}
    ]);
  }
  
  return res.status(200).json({
    products,
    stats: inventoryStats?.[0] || null,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit)
    }
  });
});

/**
 * Récupérer les produits favoris d'un utilisateur
 */
export const getUserFavorites = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;
  
  // Récupérer la liste des IDs favoris
  const user = await User.findById(userId, { favorites: 1 });
  
  if (!user || !user.favorites || user.favorites.length === 0) {
    return res.status(200).json({
      products: [],
      pagination: {
        page,
        limit,
        total: 0,
        pages: 0
      }
    });
  }
  
  // Récupérer les produits favoris avec pagination
  const [products, total] = await Promise.all([
    Product.find({ _id: { $in: user.favorites } })
      .populate('seller', 'username profilePicture')
      .sort('-createdAt')
      .skip((page - 1) * limit)
      .limit(limit),
    Product.countDocuments({ _id: { $in: user.favorites } })
  ]);
  
  return res.status(200).json({
    products,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit)
    }
  });
});

/**
 * Récupérer les produits recommandés
 */
export const getRecommendedProducts = asyncHandler(async (req: Request, res: Response) => {
  const { productId } = req.params;
  const limit = parseInt(req.query.limit as string) || 8;
  
  // Si l'ID du produit est fourni, rechercher des produits similaires
  if (productId) {
    const currentProduct = await Product.findById(productId);
    
    if (!currentProduct) {
      return res.status(404).json({ message: 'Produit non trouvé' });
    }
    
    // Trouver des produits similaires (même groupe ou même type)
    const similarProducts = await Product.find({
      _id: { $ne: productId }, // Exclure le produit actuel
      isAvailable: true,
      $or: [
        { kpopGroup: currentProduct.kpopGroup },
        { type: currentProduct.type }
      ]
    })
    .sort('-createdAt')
    .limit(limit);
    
    return res.status(200).json({
      products: similarProducts
    });
  } 
  
  // Sans ID de produit, retourner simplement les produits les plus populaires
  const popularProducts = await Product.find({ isAvailable: true })
    .sort('-views -favorites -createdAt')
    .limit(limit);
  
  return res.status(200).json({
    products: popularProducts
  });
});

/**
 * Récupérer les statistiques des produits
 */
export const getProductStats = asyncHandler(async (req: Request, res: Response) => {
  // Statistiques générales des produits
  const stats = await Product.aggregate([
    { $group: {
      _id: null,
      totalProducts: { $sum: 1 },
      //availableProducts: { $sum: { $cond: [{ $eq: ['$isAvailable', true] }, 1, 0] } },
      averagePrice: { $avg: '$price' },
      totalViews: { $sum: '$views' },
      totalFavorites: { $sum: '$favorites' }
    }}
  ]);
  
  // Distribution par type
  const typeDistribution = await Product.aggregate([
    { $group: {
      _id: '$type',
      count: { $sum: 1 },
      percentAvailable: { 
        $avg: { $cond: [{ $eq: ['$isAvailable', true] }, 1, 0] }
      }
    }}
  ]);
  
  // Distribution par groupe K-pop (top 10)
  const groupDistribution = await Product.aggregate([
    { $group: {
      _id: '$kpopGroup',
      count: { $sum: 1 }
    }},
    { $sort: { count: -1 } },
    { $limit: 10 }
  ]);
  
  return res.status(200).json({
    generalStats: stats[0] || {},
    typeDistribution,
    groupDistribution
  });
});