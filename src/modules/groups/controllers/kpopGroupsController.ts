import { Request, Response } from 'express';
import mongoose from 'mongoose';
import KpopGroup, { IKpopGroup } from '../../../models/kpopGroupModel';
import Album from '../../../models/albumModel';
import Product from '../../../models/productModel';
import { asyncHandler } from '../../../commons/middlewares/errorMiddleware';
import logger from '../../../commons/utils/logger';

interface GroupFilters {
  isActive?: boolean;
  genre?: string;
  tag?: string;
  parentGroup?: string;
  search?: string;
  [key: string]: any;
}

interface PaginationQuery {
  page?: string;
  limit?: string;
  sortBy?: string;
  sortOrder?: string;
  [key: string]: any;
}

interface GroupRequest extends Request {
  query: PaginationQuery & GroupFilters & {
    includeInactive?: string;
    [key: string]: any;
  };
}

/**
 * Créer un nouveau groupe K-pop (Admin uniquement)
 */
export const createKpopGroup = asyncHandler(async (req: Request, res: Response) => {
  const groupData = req.body;
  
  try {
    // Vérifier que le groupe n'existe pas déjà
    const existingGroup = await KpopGroup.findOne({ 
      name: { $regex: new RegExp(`^${groupData.name}$`, 'i') }
    });
    
    if (existingGroup) {
      return res.status(400).json({ 
        message: 'Un groupe avec ce nom existe déjà' 
      });
    }
    
    groupData.discoverySource = 'Manual';
    groupData.lastScraped = new Date();
    
    const group = new KpopGroup(groupData);
    await group.save();
    
    logger.info('Nouveau groupe K-pop créé', { 
      groupId: group._id, 
      groupName: group.name 
    });
    
    return res.status(201).json({
      message: 'Groupe K-pop créé avec succès',
      group
    });
  } catch (error) {
    logger.error('Erreur lors de la création du groupe K-pop', { 
      error: error instanceof Error ? error.message : 'Erreur inconnue',
      groupData: groupData.name
    });
    
    return res.status(500).json({ 
      message: 'Une erreur est survenue lors de la création du groupe' 
    });
  }
});

/**
 * Récupérer tous les groupes K-pop avec pagination et filtres
 */
export const getKpopGroups = asyncHandler(async (req: GroupRequest, res: Response) => {
  const page = parseInt(req.query.page || '1');
  const limit = parseInt(req.query.limit || '20');
  const sortBy = req.query.sortBy || 'name';
  const sortOrder = req.query.sortOrder === 'desc' ? -1 : 1;
  
  // Construction des filtres
  const filters: any = {};
  
  if (req.query.genre) {
    filters.genres = { $in: [req.query.genre] };
  }
  
  if (req.query.tag) {
    filters.tags = { $in: [req.query.tag] };
  }
  
  if (req.query.search) {
    filters.$or = [
      { name: { $regex: req.query.search, $options: 'i' } },
      { description: { $regex: req.query.search, $options: 'i' } }
    ];
  }
  
  try {
    const [groups, total] = await Promise.all([
      KpopGroup.find(filters)
        .sort({ [sortBy]: sortOrder })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      KpopGroup.countDocuments(filters)
    ]);
    
    return res.status(200).json({
      groups,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    logger.error('Erreur lors de la récupération des groupes', { 
      error: error instanceof Error ? error.message : 'Erreur inconnue'
    });
    
    return res.status(500).json({ 
      message: 'Une erreur est survenue lors de la récupération des groupes' 
    });
  }
});

/**
 * Rerchercher des groupes K-pop avec des filtres avancés
 */
export const searchGroups = asyncHandler(async (req: GroupRequest, res: Response) => {
  const { query } = req.query;
  const limit = parseInt(req.query.limit || '20');
  const includeInactive = req.query.includeInactive === 'true';
  
  if (!query || typeof query !== 'string') {
    return res.status(400).json({ message: 'Paramètre de recherche requis' });
  }
  
  try {
    const searchRegex = new RegExp(query.trim(), 'i');
    
    const filters: any = {
      $or: [
        { name: { $regex: searchRegex } },
        { tags: { $elemMatch: { $regex: searchRegex } } },
        { genres: { $elemMatch: { $regex: searchRegex } } }
      ]
    };
    
    // ✅ INCLURE LES GROUPES INACTIFS SEULEMENT SI DEMANDÉ
    if (!includeInactive) {
      filters.isActive = true;
    }
    
    const groups = await KpopGroup.find(filters)
      .select('name profileImage genres tags invalidReason followersCount')
      .limit(limit)
      .sort({ isActive: -1, name: 1 })
      .lean();
    
    const enrichedGroups = await Promise.all(
      groups.map(async (group) => {
        const albumStats = await Album.aggregate([
          { $match: { artistId: group._id } },
          {
            $group: {
              _id: null,
              albumCount: { $sum: 1 },
              totalTracks: { $sum: '$totalTracks' },
              latestRelease: { $max: '$releaseDate' }
            }
          }
        ]);
        
        return {
          ...group,
          stats: albumStats[0] || { albumCount: 0, totalTracks: 0, latestRelease: null }
        };
      })
    );
    
    logger.info('Recherche de groupes effectuée', { 
      query, 
      found: groups.length,
      includeInactive
    });
    
    return res.status(200).json({
      groups: enrichedGroups,
      query,
      found: groups.length,
      includeInactive
    });
  } catch (error) {
    logger.error('Erreur lors de la recherche de groupes', { 
      error: error instanceof Error ? error.message : 'Erreur inconnue',
      query
    });
    
    return res.status(500).json({ 
      message: 'Une erreur est survenue lors de la recherche' 
    });
  }
});

/**
 * Récupérer les groupes K-pop les plus populaires
 */
export const getPopularGroups = asyncHandler(async (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string) || 20;
  
  try {
    const popularGroups = await Album.aggregate([
      {
        $group: {
          _id: '$artistId',
          albumCount: { $sum: 1 },
          totalTracks: { $sum: '$totalTracks' },
          latestRelease: { $max: '$releaseDate' }
        }
      },
      { $sort: { albumCount: -1 } },
      { $limit: limit },
      {
        $lookup: {
          from: 'kpopgroups',
          localField: '_id',
          foreignField: '_id',
          as: 'group'
        }
      },
      { $unwind: '$group' },
      {
        $project: {
          _id: '$group._id',
          name: '$group.name',
          profileImage: '$group.profileImage',
          genres: '$group.genres',
          followersCount: '$group.followersCount',
          albumCount: 1,
          totalTracks: 1,
          latestRelease: 1
        }
      }
    ]);
    
    return res.status(200).json({
      groups: popularGroups,
      total: popularGroups.length
    });
  } catch (error) {
    logger.error('Erreur lors de la récupération des groupes populaires', { 
      error: error instanceof Error ? error.message : 'Erreur inconnue'
    });
    
    return res.status(500).json({ 
      message: 'Une erreur est survenue' 
    });
  }
});

/**
 * Récupérer un groupe K-pop par son ID avec ses albums et statistiques
 */
export const getKpopGroupById = asyncHandler(async (req: Request, res: Response) => {
  const { groupId } = req.params;
  
  if (!mongoose.Types.ObjectId.isValid(groupId)) {
    return res.status(400).json({ message: 'ID de groupe invalide' });
  }
  
  try {
    const group = await KpopGroup.findById(groupId);
    
    if (!group) {
      return res.status(404).json({ message: 'Groupe non trouvé' });
    }
    
    const albums = await Album.find({ artistId: groupId })
      .sort({ releaseDate: -1 })
      .lean();
    
    const productStats = await Product.aggregate([
      { $match: { kpopGroup: group.name, isAvailable: true } },
      {
        $group: {
          _id: null,
          totalProducts: { $sum: 1 },
          averagePrice: { $avg: '$price' },
          minPrice: { $min: '$price' },
          maxPrice: { $max: '$price' }
        }
      }
    ]);
    
    const albumStats = {
      totalAlbums: albums.length,
      totalTracks: albums.reduce((sum: number, album: any) => sum + (album.totalTracks || 0), 0),
      averageTracksPerAlbum: albums.length > 0 ? 
        Math.round((albums.reduce((sum: number, album: any) => sum + (album.totalTracks || 0), 0) / albums.length) * 10) / 10 : 0,
      latestAlbum: albums.length > 0 ? albums[0] : null,
      oldestAlbum: albums.length > 0 ? albums[albums.length - 1] : null,
      releaseYears: albums
        .filter((album: any) => album.releaseDate)
        .map((album: any) => new Date(album.releaseDate!).getFullYear())
        .filter((year: number, index: number, arr: number[]) => arr.indexOf(year) === index)
        .sort((a: number, b: number) => b - a)
    };
    
    return res.status(200).json({
      group,
      albums,
      stats: {
        ...albumStats,
        products: productStats[0] || { 
          totalProducts: 0, 
          averagePrice: 0, 
          minPrice: 0, 
          maxPrice: 0 
        }
      }
    });
  } catch (error) {
    logger.error('Erreur lors de la récupération du groupe', { 
      error: error instanceof Error ? error.message : 'Erreur inconnue',
      groupId
    });
    
    return res.status(500).json({ 
      message: 'Une erreur est survenue lors de la récupération du groupe' 
    });
  }
});

/**
 * Mettre à jour un groupe K-pop (Admin uniquement)
 */
export const updateKpopGroup = asyncHandler(async (req: Request, res: Response) => {
  const { groupId } = req.params;
  const updates = req.body;
  
  if (!mongoose.Types.ObjectId.isValid(groupId)) {
    return res.status(400).json({ message: 'ID de groupe invalide' });
  }
  
  try {
    const oldGroup = await KpopGroup.findById(groupId);
    if (!oldGroup) {
      return res.status(404).json({ message: 'Groupe non trouvé' });
    }
    
    updates.lastScraped = new Date();
    
    const group = await KpopGroup.findByIdAndUpdate(
      groupId,
      { $set: updates },
      { new: true, runValidators: true }
    );
    
    if (updates.name && updates.name !== oldGroup.name) {
      const updateResult = await Album.updateMany(
        { artistId: groupId },
        { $set: { artistName: updates.name } }
      );
      
      logger.info('Nom du groupe mis à jour dans les albums', {
        groupId,
        oldName: oldGroup.name,
        newName: updates.name,
        albumsUpdated: updateResult.modifiedCount
      });
    }
    
    return res.status(200).json({
      message: 'Groupe mis à jour avec succès',
      group
    });
  } catch (error) {
    logger.error('Erreur lors de la mise à jour du groupe', { 
      error: error instanceof Error ? error.message : 'Erreur inconnue',
      groupId
    });
    
    return res.status(500).json({ 
      message: 'Une erreur est survenue lors de la mise à jour du groupe' 
    });
  }
});

/**
 * Supprimer un groupe (Admin uniquement)
 */
export const deleteKpopGroup = asyncHandler(async (req: Request, res: Response) => {
  const { groupId } = req.params;
  
  if (!mongoose.Types.ObjectId.isValid(groupId)) {
    return res.status(400).json({ message: 'ID de groupe invalide' });
  }
  
  try {
    const group = await KpopGroup.findById(groupId);
    
    if (!group) {
      return res.status(404).json({ message: 'Groupe non trouvé' });
    }
    
    const albumsDeleted = await Album.deleteMany({ artistId: groupId });
    
    await KpopGroup.findByIdAndDelete(groupId);
    
    logger.info('Groupe et albums supprimés', { 
      groupId,
      groupName: group.name,
      albumsDeleted: albumsDeleted.deletedCount
    });
    
    return res.status(200).json({
      message: 'Groupe supprimé avec succès',
      albumsDeleted: albumsDeleted.deletedCount
    });
  } catch (error) {
    logger.error('Erreur lors de la suppression du groupe', { 
      error: error instanceof Error ? error.message : 'Erreur inconnue',
      groupId
    });
    
    return res.status(500).json({ 
      message: 'Une erreur est survenue lors de la suppression du groupe' 
    });
  }
});