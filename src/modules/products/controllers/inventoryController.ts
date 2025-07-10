import { Request, Response } from 'express';
import User from '../../../models/userModel';
import Product from '../../../models/productModel';
import { asyncHandler } from '../../../commons/middlewares/errorMiddleware';
import logger from '../../../commons/utils/logger';

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
  const userId = (req.user as any)?.id;
  const limit = parseInt(req.query.limit as string) || 8;
  
  let recommendedProducts: any[] = [];
  
  if (userId) {
    // Récupérer l'utilisateur avec ses favoris et préférences
    const user = await User.findById(userId, { 
      favorites: 1, 
      preferences: 1 
    });
    
    if (user) {
      // 1. Récupérer les groupes/types des favoris de l'utilisateur
      const favoriteProducts = await Product.find({ 
        _id: { $in: user.favorites || [] } 
      }, { kpopGroup: 1, type: 1, kpopMember: 1 });
      
      // Extraire les groupes et types préférés
      const preferredGroups = [...new Set(favoriteProducts.map(p => p.kpopGroup).filter(Boolean))];
      const preferredTypes = [...new Set(favoriteProducts.map(p => p.type).filter(Boolean))];
      const preferredMembers = [...new Set(favoriteProducts.map(p => p.kpopMember).filter(Boolean))];
      
      // 2. Ajouter les groupes des préférences utilisateur
      const userPreferredGroups = user.preferences?.kpopGroups || [];
      const allPreferredGroups = [...new Set([...preferredGroups, ...userPreferredGroups])];
      
      // 3. Construire la requête de recommandation
      const recommendationQuery: any = {
        isAvailable: true,
        seller: { $ne: userId }, // Exclure les produits de l'utilisateur
        _id: { $nin: user.favorites || [] } // Exclure les favoris déjà existants
      };
      
      // Si on a des préférences, les utiliser
      if (allPreferredGroups.length > 0 || preferredTypes.length > 0 || preferredMembers.length > 0) {
        recommendationQuery.$or = [];
        
        if (allPreferredGroups.length > 0) {
          recommendationQuery.$or.push({ kpopGroup: { $in: allPreferredGroups } });
        }
        
        if (preferredTypes.length > 0) {
          recommendationQuery.$or.push({ type: { $in: preferredTypes } });
        }
        
        if (preferredMembers.length > 0) {
          recommendationQuery.$or.push({ kpopMember: { $in: preferredMembers } });
        }
      }
      
      // 4. Récupérer les recommandations avec scoring
      recommendedProducts = await Product.aggregate([
        { $match: recommendationQuery },
        {
          $addFields: {
            // Score basé sur les préférences
            preferenceScore: {
              $add: [
                // +3 points si le groupe correspond aux favoris
                { $cond: [{ $in: ['$kpopGroup', allPreferredGroups] }, 3, 0] },
                // +2 points si le type correspond
                { $cond: [{ $in: ['$type', preferredTypes] }, 2, 0] },
                // +2 points si le membre correspond
                { $cond: [{ $in: ['$kpopMember', preferredMembers] }, 2, 0] },
                // +1 point pour la popularité (vues + favoris normalisés)
                { $divide: [{ $add: ['$views', { $multiply: ['$favorites', 2] }] }, 100] }
              ]
            }
          }
        },
        { $sort: { preferenceScore: -1, createdAt: -1 } },
        { $limit: limit },
        {
          $lookup: {
            from: 'users',
            localField: 'seller',
            foreignField: '_id',
            as: 'seller'
          }
        },
        {
          $project: {
            _id: 1,
            title: 1,
            price: 1,
            currency: 1,
            images: 1,
            kpopGroup: 1,
            kpopMember: 1,
            type: 1,
            condition: 1,
            views: 1,
            favorites: 1,
            createdAt: 1,
            'seller.username': 1,
            'seller.profilePicture': 1,
            preferenceScore: 1
          }
        }
      ]);
    }
  }
  
  // Si pas assez de recommandations personnalisées, compléter avec des produits populaires
  if (recommendedProducts.length < limit) {
    const remainingLimit = limit - recommendedProducts.length;
    const excludeIds = recommendedProducts.map(p => p._id);
    if (userId) excludeIds.push(userId);
    
    const popularProducts = await Product.find({ 
      isAvailable: true,
      seller: { $ne: userId },
      _id: { $nin: excludeIds }
    })
    .populate('seller', 'username profilePicture')
    .sort('-views -favorites -createdAt')
    .limit(remainingLimit);
    
    recommendedProducts = [...recommendedProducts, ...popularProducts];
  }
  
  return res.status(200).json({
    products: recommendedProducts,
    isPersonalized: userId && recommendedProducts.length > 0
  });
});

/**
 * Récupérer des recommandations rapides
 */
export const getQuickRecommendations = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any)?.id;
  const limit = parseInt(req.query.limit as string) || 4;
  
  // Version simplifiée pour un chargement plus rapide
  const quickRecommendations = await Product.find({
    isAvailable: true,
    seller: { $ne: userId },
    views: { $gte: 10 }
  })
  .select('title price currency images kpopGroup type createdAt')
  .sort('-views -createdAt')
  .limit(limit)
  .lean();
  
  return res.status(200).json({
    products: quickRecommendations
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