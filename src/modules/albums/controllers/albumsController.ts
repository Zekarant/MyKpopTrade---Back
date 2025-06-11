import { Request, Response } from 'express';
import mongoose from 'mongoose';
import Album from '../../../models/albumModel';
import KpopGroup from '../../../models/kpopGroupModel';
import Product from '../../../models/productModel';
import { asyncHandler } from '../../../commons/middlewares/errorMiddleware';
import logger from '../../../commons/utils/logger';

/**
 * Créer un nouvel album (Admin uniquement)
 */
export const createAlbum = asyncHandler(async (req: Request, res: Response) => {
  const albumData = req.body;
  
  try {
    // Vérifier que le groupe existe
    const group = await KpopGroup.findById(albumData.artistId);
    if (!group) {
      return res.status(400).json({ message: 'Groupe non trouvé' });
    }
    
    // AJOUTER LE NOM DE L'ARTISTE AUTOMATIQUEMENT
    albumData.artistName = group.name;
    albumData.discoverySource = albumData.discoverySource;
    albumData.lastScraped = new Date();
    
    const album = new Album(albumData);
    await album.save();
    
    // Populer les données du groupe pour la réponse
    await album.populate('artistId', 'name description profileImage');
    
    logger.info('Nouvel album créé', { 
      albumId: album._id, 
      albumName: album.name,
      groupName: group.name,
      spotifyId: album.spotifyId
    });
    
    return res.status(201).json({
      message: 'Album créé avec succès',
      album
    });
  } catch (error) {
    logger.error('Erreur lors de la création de l\'album', { 
      error: error instanceof Error ? error.message : 'Erreur inconnue',
      albumData: albumData.name
    });
    
    return res.status(500).json({ 
      message: 'Une erreur est survenue lors de la création de l\'album' 
    });
  }
});

/**
 * Récupérer tous les albums avec pagination et filtres
 */
export const getAlbums = asyncHandler(async (req: Request, res: Response) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;
  const sortBy = req.query.sortBy as string || 'releaseDate';
  const sortOrder = req.query.sortOrder === 'asc' ? 1 : -1;
  
  // Construction des filtres
  const filters: any = {};
  
  if (req.query.artistId) {
    filters.artistId = req.query.artistId;
  }
  
  if (req.query.artistName) {
    filters.artistName = { $regex: req.query.artistName, $options: 'i' };
  }
  
  if (req.query.search) {
    filters.$or = [
      { name: { $regex: req.query.search, $options: 'i' } },
      { artistName: { $regex: req.query.search, $options: 'i' } }
    ];
  }
  
  if (req.query.minTracks) {
    const minTracks = parseInt(req.query.minTracks as string);
    filters.totalTracks = { $gte: minTracks };
  }
  
  if (req.query.year) {
    const year = parseInt(req.query.year as string);
    filters.releaseDate = {
      $gte: new Date(`${year}-01-01`),
      $lt: new Date(`${year + 1}-01-01`)
    };
  }
  
  try {
    const [albums, total] = await Promise.all([
      Album.find(filters)
        .populate('artistId', 'name profileImage')
        .sort({ [sortBy]: sortOrder })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Album.countDocuments(filters)
    ]);
    
    return res.status(200).json({
      albums,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    logger.error('Erreur lors de la récupération des albums', { 
      error: error instanceof Error ? error.message : 'Erreur inconnue'
    });
    
    return res.status(500).json({ 
      message: 'Une erreur est survenue lors de la récupération des albums' 
    });
  }
});

/**
 * Récupérer un album par son ID avec produits disponibles
 */
export const getAlbumById = asyncHandler(async (req: Request, res: Response) => {
  const { albumId } = req.params;
  
  if (!mongoose.Types.ObjectId.isValid(albumId)) {
    return res.status(400).json({ message: 'ID d\'album invalide' });
  }
  
  try {
    const album = await Album.findById(albumId)
      .populate('artistId', 'name description profileImage socialLinks');
    
    if (!album) {
      return res.status(404).json({ message: 'Album non trouvé' });
    }
    
    const availableProducts = await Product.find({
      $or: [
        { albumName: album.name },
        { kpopGroup: album.artistName }
      ],
      isAvailable: true
    })
    .populate('seller', 'username profilePicture statistics.averageRating')
    .sort({ price: 1 })
    .limit(10);
    
    return res.status(200).json({
      album,
      availableProducts,
      stats: {
        totalProducts: availableProducts.length,
        totalTracks: album.totalTracks,
        releaseYear: album.releaseDate ? new Date(album.releaseDate).getFullYear() : null,
        priceRange: availableProducts.length > 0 ? {
          min: Math.min(...availableProducts.map(p => p.price)),
          max: Math.max(...availableProducts.map(p => p.price))
        } : null
      }
    });
  } catch (error) {
    logger.error('Erreur lors de la récupération de l\'album', { 
      error: error instanceof Error ? error.message : 'Erreur inconnue',
      albumId
    });
    
    return res.status(500).json({ 
      message: 'Une erreur est survenue lors de la récupération de l\'album' 
    });
  }
});

/**
 * Récupérer les albums d'un groupe
 */
export const getAlbumsByGroup = asyncHandler(async (req: Request, res: Response) => {
  const { groupId } = req.params;
  
  if (!mongoose.Types.ObjectId.isValid(groupId)) {
    return res.status(400).json({ message: 'ID de groupe invalide' });
  }
  
  try {
    const albums = await Album.find({ artistId: groupId })
      .sort({ releaseDate: -1 })
      .lean();
    
    if (albums.length === 0) {
      return res.status(200).json({
        albums: [],
        message: 'Aucun album trouvé pour ce groupe'
      });
    }
    
    const albumsWithProducts = await Promise.all(
      albums.map(async (album) => {
        const productCount = await Product.countDocuments({
          $or: [
            { albumName: album.name },
            { kpopGroup: album.artistName }
          ],
          isAvailable: true
        });
        
        return {
          ...album,
          availableProducts: productCount
        };
      })
    );
    
    return res.status(200).json({
      albums: albumsWithProducts
    });
  } catch (error) {
    logger.error('Erreur lors de la récupération des albums du groupe', { 
      error: error instanceof Error ? error.message : 'Erreur inconnue',
      groupId
    });
    
    return res.status(500).json({ 
      message: 'Une erreur est survenue lors de la récupération des albums' 
    });
  }
});

/**
 * Récupérer les albums les plus récents
 */
export const getRecentAlbums = asyncHandler(async (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string) || 50;
  
  try {
    const albums = await Album.find({})
      .sort({ releaseDate: -1 })
      .limit(limit)
      .populate('artistId', 'name profileImage')
      .lean();
    
    return res.status(200).json({
      albums,
      message: `${albums.length} albums les plus récents`
    });
  } catch (error) {
    logger.error('Erreur lors de la récupération des albums récents', { 
      error: error instanceof Error ? error.message : 'Erreur inconnue'
    });
    
    return res.status(500).json({ 
      message: 'Une erreur est survenue lors de la récupération des albums récents' 
    });
  }
});

/**
 * Recherche d'albums par nom ou artiste
 */
export const searchAlbums = asyncHandler(async (req: Request, res: Response) => {
  const { query } = req.query;
  const limit = parseInt(req.query.limit as string) || 20;
  
  if (!query || typeof query !== 'string') {
    return res.status(400).json({ message: 'Paramètre de recherche requis' });
  }
  
  try {
    const albums = await Album.find({
      $or: [
        { name: { $regex: query, $options: 'i' } },
        { artistName: { $regex: query, $options: 'i' } }
      ]
    })
    .sort({ releaseDate: -1 })
    .limit(limit)
    .populate('artistId', 'name profileImage')
    .lean();
    
    return res.status(200).json({
      albums,
      query,
      found: albums.length
    });
  } catch (error) {
    logger.error('Erreur lors de la recherche d\'albums', { 
      error: error instanceof Error ? error.message : 'Erreur inconnue',
      query
    });
    
    return res.status(500).json({ 
      message: 'Une erreur est survenue lors de la recherche' 
    });
  }
});

/**
 * Mettre à jour un album (Admin uniquement)
 */
export const updateAlbum = asyncHandler(async (req: Request, res: Response) => {
  const { albumId } = req.params;
  const updates = req.body;
  
  if (!mongoose.Types.ObjectId.isValid(albumId)) {
    return res.status(400).json({ message: 'ID d\'album invalide' });
  }
  
  try {
    // Si on change l'artistId, mettre à jour aussi artistName
    if (updates.artistId) {
      const group = await KpopGroup.findById(updates.artistId);
      if (!group) {
        return res.status(400).json({ message: 'Groupe non trouvé' });
      }
      updates.artistName = group.name;
    }
    
    updates.lastScraped = new Date();
    
    const album = await Album.findByIdAndUpdate(
      albumId,
      { $set: updates },
      { new: true, runValidators: true }
    ).populate('artistId', 'name description profileImage');
    
    if (!album) {
      return res.status(404).json({ message: 'Album non trouvé' });
    }
    
    logger.info('Album mis à jour', { 
      albumId,
      albumName: album.name,
      artistName: album.artistName,
      spotifyId: album.spotifyId
    });
    
    return res.status(200).json({
      message: 'Album mis à jour avec succès',
      album
    });
  } catch (error) {
    logger.error('Erreur lors de la mise à jour de l\'album', { 
      error: error instanceof Error ? error.message : 'Erreur inconnue',
      albumId
    });
    
    return res.status(500).json({ 
      message: 'Une erreur est survenue lors de la mise à jour de l\'album' 
    });
  }
});

/**
 * Supprimer un album (Admin uniquement)
 */
export const deleteAlbum = asyncHandler(async (req: Request, res: Response) => {
  const { albumId } = req.params;
  
  if (!mongoose.Types.ObjectId.isValid(albumId)) {
    return res.status(400).json({ message: 'ID d\'album invalide' });
  }
  
  try {
    const album = await Album.findByIdAndDelete(albumId);
    
    if (!album) {
      return res.status(404).json({ message: 'Album non trouvé' });
    }
    
    logger.info('Album supprimé', { 
      albumId,
      albumName: album.name,
      artistName: album.artistName,
      spotifyId: album.spotifyId
    });
    
    return res.status(200).json({
      message: 'Album supprimé avec succès'
    });
  } catch (error) {
    logger.error('Erreur lors de la suppression de l\'album', { 
      error: error instanceof Error ? error.message : 'Erreur inconnue',
      albumId
    });
    
    return res.status(500).json({ 
      message: 'Une erreur est survenue lors de la suppression de l\'album' 
    });
  }
});

/**
 * Récupérer un album par son Spotify ID
 */
export const getAlbumBySpotifyId = asyncHandler(async (req: Request, res: Response) => {
  const { spotifyId } = req.params;
  
  try {
    const album = await Album.findOne({ spotifyId })
      .populate('artistId', 'name description profileImage');
    
    if (!album) {
      return res.status(404).json({ message: 'Album non trouvé' });
    }
    
    return res.status(200).json({ album });
  } catch (error) {
    logger.error('Erreur lors de la récupération de l\'album par Spotify ID', { 
      error: error instanceof Error ? error.message : 'Erreur inconnue',
      spotifyId
    });
    
    return res.status(500).json({ 
      message: 'Une erreur est survenue lors de la récupération de l\'album' 
    });
  }
});