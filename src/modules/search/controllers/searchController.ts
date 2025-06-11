import { Request, Response } from 'express';
import mongoose, { SortOrder } from 'mongoose';
import Product from '../../../models/productModel';
import KpopGroup from '../../../models/kpopGroupModel';
import Album from '../../../models/albumModel';
import SearchHistory from '../../../models/historicSearchModel';
import { asyncHandler } from '../../../commons/middlewares/errorMiddleware';
import logger from '../../../commons/utils/logger';

/**
 * Interface pour les filtres de recherche
 */
interface SearchFilters {
  query?: string;
  groups?: string[];
  members?: string[];
  albums?: string[];
  priceRange?: {
    min?: number;
    max?: number;
  };
  condition?: string[];
  type?: string;
  albumType?: string;
  era?: string;
  company?: string;
  currency?: string;
}

/**
 * Recherche avancée de produits
 */
export const advancedSearch = asyncHandler(async (req: Request, res: Response) => {
  const {
    query,
    groups,
    members,
    albums,
    priceRange,
    condition,
    type,
    albumType,
    era,
    company,
    currency,
    page = 1,
    limit = 20,
    sortBy = 'relevance'
  }: SearchFilters & { page?: number; limit?: number; sortBy?: string } = req.body;

  const userId = (req.user as any)?.id;

  try {
    // Construire les filtres de recherche
    const searchFilters: any = { isAvailable: true };
    
    // Recherche textuelle
    if (query && query.trim()) {
      searchFilters.$or = [
        { title: { $regex: query.trim(), $options: 'i' } },
        { description: { $regex: query.trim(), $options: 'i' } },
        { kpopGroup: { $regex: query.trim(), $options: 'i' } },
        { kpopMember: { $regex: query.trim(), $options: 'i' } },
        { albumName: { $regex: query.trim(), $options: 'i' } }
      ];
    }

    // Filtres spécifiques
    if (groups?.length) {
      searchFilters.kpopGroup = { $in: groups };
    }
    
    if (members?.length) {
      searchFilters.kpopMember = { $in: members };
    }
    
    if (albums?.length) {
      searchFilters.albumName = { $in: albums };
    }
    
    if (type) {
      searchFilters.type = type;
    }
    
    if (condition?.length) {
      searchFilters.condition = { $in: condition };
    }
    
    if (currency) {
      searchFilters.currency = currency;
    }
    
    // Filtre de prix
    if (priceRange) {
      searchFilters.price = {};
      if (priceRange.min !== undefined) searchFilters.price.$gte = priceRange.min;
      if (priceRange.max !== undefined) searchFilters.price.$lte = priceRange.max;
    }

    // Option de tri avec typage correct
    const getSortOption = (sortBy: string): Record<string, SortOrder> | Record<string, { $meta: string }> => {
      switch (sortBy) {
        case 'price_asc': 
          return { price: 1 as SortOrder };
        case 'price_desc': 
          return { price: -1 as SortOrder };
        case 'newest': 
          return { createdAt: -1 as SortOrder };
        case 'oldest': 
          return { createdAt: 1 as SortOrder };
        case 'popular': 
          return { views: -1 as SortOrder, favorites: -1 as SortOrder };
        case 'relevance':
        default:
          return query ? { score: { $meta: 'textScore' } } : { createdAt: -1 as SortOrder };
      }
    };

    // Projection pour la recherche textuelle
    const projection = query ? { score: { $meta: 'textScore' } } : {};

    // Exécuter la recherche
    const [products, total] = await Promise.all([
      Product.find(searchFilters, projection)
        .populate('seller', 'username profilePicture statistics.averageRating')
        .sort(getSortOption(sortBy))
        .skip((page - 1) * limit)
        .limit(limit),
      Product.countDocuments(searchFilters)
    ]);

    // Sauvegarder l'historique de recherche si utilisateur connecté
    if (userId && query && query.trim()) {
      await SearchHistory.findOneAndUpdate(
        { userId, query: query.toLowerCase().trim() },
        { 
          userId, 
          query: query.toLowerCase().trim(),
          filters: { groups, members, albums, priceRange, condition, type, albumType, era, company },
          resultCount: total,
          lastSearched: new Date(),
          $inc: { searchCount: 1 }
        },
        { upsert: true, new: true }
      );
    }

    return res.status(200).json({
      products,
      pagination: { 
        page, 
        limit, 
        total, 
        pages: Math.ceil(total / limit) 
      },
      searchMetadata: {
        query: query?.trim(),
        appliedFilters: { groups, members, albums, priceRange, condition, type, albumType, era, company },
        resultCount: total,
        sortBy
      }
    });
  } catch (error) {
    logger.error('Erreur lors de la recherche avancée', { 
      error: error instanceof Error ? error.message : 'Erreur inconnue',
      userId,
      query
    });
    
    return res.status(500).json({ 
      message: 'Une erreur est survenue lors de la recherche' 
    });
  }
});

/**
 * Récupérer l'historique de recherche d'un utilisateur
 */
export const getUserSearchHistory = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const limit = parseInt(req.query.limit as string) || 20;

  try {
    const searchHistory = await SearchHistory.find({ userId })
      .sort({ lastSearched: -1 })
      .limit(limit)
      .lean();

    return res.status(200).json({
      searchHistory
    });
  } catch (error) {
    logger.error('Erreur lors de la récupération de l\'historique', { 
      error: error instanceof Error ? error.message : 'Erreur inconnue',
      userId
    });
    
    return res.status(500).json({ 
      message: 'Une erreur est survenue lors de la récupération de l\'historique' 
    });
  }
});

/**
 * Supprimer un élément de l'historique de recherche
 */
export const deleteSearchHistoryItem = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const { historyId } = req.params;

  try {
    const deleted = await SearchHistory.findOneAndDelete({
      _id: historyId,
      userId
    });

    if (!deleted) {
      return res.status(404).json({ 
        message: 'Élément d\'historique non trouvé' 
      });
    }

    return res.status(200).json({
      message: 'Élément supprimé de l\'historique'
    });
  } catch (error) {
    logger.error('Erreur lors de la suppression de l\'historique', { 
      error: error instanceof Error ? error.message : 'Erreur inconnue',
      userId,
      historyId
    });
    
    return res.status(500).json({ 
      message: 'Une erreur est survenue lors de la suppression' 
    });
  }
});

/**
 * Vider complètement l'historique de recherche
 */
export const clearSearchHistory = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;

  try {
    await SearchHistory.deleteMany({ userId });

    return res.status(200).json({
      message: 'Historique de recherche vidé avec succès'
    });
  } catch (error) {
    logger.error('Erreur lors du vidage de l\'historique', { 
      error: error instanceof Error ? error.message : 'Erreur inconnue',
      userId
    });
    
    return res.status(500).json({ 
      message: 'Une erreur est survenue lors du vidage de l\'historique' 
    });
  }
});

/**
 * Obtenir des suggestions de recherche
 */
export const getSearchSuggestions = asyncHandler(async (req: Request, res: Response) => {
  const { query } = req.query;

  if (!query || typeof query !== 'string' || query.length < 2) {
    return res.status(400).json({ 
      message: 'Requête trop courte pour les suggestions' 
    });
  }

  try {
    const [groupSuggestions, albumSuggestions, memberSuggestions] = await Promise.all([
      // Suggestions de groupes
      KpopGroup.find({
        $or: [
          { name: { $regex: query, $options: 'i' } },
          { koreanName: { $regex: query, $options: 'i' } }
        ],
        isActive: true
      })
      .select('name koreanName profileImage')
      .limit(5)
      .lean(),
      
      // Suggestions d'albums
      Album.find({
        $or: [
          { title: { $regex: query, $options: 'i' } },
          { koreanTitle: { $regex: query, $options: 'i' } }
        ]
      })
      .populate('group', 'name')
      .select('title koreanTitle coverImage group')
      .limit(5)
      .lean(),
      
      // Suggestions de membres (depuis les groupes)
      KpopGroup.aggregate([
        { $unwind: '$members' },
        {
          $match: {
            $or: [
              { 'members.name': { $regex: query, $options: 'i' } },
              { 'members.stageName': { $regex: query, $options: 'i' } }
            ],
            'members.isActive': true
          }
        },
        {
          $project: {
            memberName: '$members.name',
            memberStageName: '$members.stageName',
            memberImage: '$members.profileImage',
            groupName: '$name'
          }
        },
        { $limit: 5 }
      ])
    ]);

    return res.status(200).json({
      suggestions: {
        groups: groupSuggestions,
        albums: albumSuggestions,
        members: memberSuggestions
      }
    });
  } catch (error) {
    logger.error('Erreur lors de la génération des suggestions', { 
      error: error instanceof Error ? error.message : 'Erreur inconnue',
      query
    });
    
    return res.status(500).json({ 
      message: 'Une erreur est survenue lors de la génération des suggestions' 
    });
  }
});