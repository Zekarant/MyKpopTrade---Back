import { Request, Response } from 'express';
import { asyncHandler } from '../../../commons/middlewares/errorMiddleware';
import logger from '../../../commons/utils/logger';
import { mapHttpError } from '../../../commons/utils/httpErrorMapper';
import {
  createAlbumForGroup,
  listAlbums,
  fetchAlbumById,
  fetchAlbumsByGroup,
  fetchRecentAlbums,
  searchAlbumsByQuery,
  updateAlbumById,
  deleteAlbumById,
  fetchAlbumBySpotifyId
} from '../services/albumsService';

/**
 * Créer un nouvel album (Admin uniquement)
 */
export const createAlbum = asyncHandler(async (req: Request, res: Response) => {
  const albumData = req.body;

  try {
    const album = await createAlbumForGroup(albumData);
    return res.status(201).json({
      message: 'Album créé avec succès',
      album
    });
  } catch (error) {
    const mapped = mapHttpError(res, error);
    if (mapped) return mapped;

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
  try {
    const result = await listAlbums(req.query);
    return res.status(200).json(result);
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
  const albumId = req.params.albumId as string;

  try {
    const result = await fetchAlbumById(albumId);
    return res.status(200).json(result);
  } catch (error) {
    const mapped = mapHttpError(res, error);
    if (mapped) return mapped;

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
  const groupId = req.params.groupId as string;

  try {
    const { albums, empty } = await fetchAlbumsByGroup(groupId);

    if (empty) {
      return res.status(200).json({
        albums: [],
        message: 'Aucun album trouvé pour ce groupe'
      });
    }

    return res.status(200).json({ albums });
  } catch (error) {
    const mapped = mapHttpError(res, error);
    if (mapped) return mapped;

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
    const albums = await fetchRecentAlbums(limit);
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

  try {
    const result = await searchAlbumsByQuery({ query, limit });
    return res.status(200).json(result);
  } catch (error) {
    const mapped = mapHttpError(res, error);
    if (mapped) return mapped;

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
  const albumId = req.params.albumId as string;

  try {
    const album = await updateAlbumById(albumId, req.body);
    return res.status(200).json({
      message: 'Album mis à jour avec succès',
      album
    });
  } catch (error) {
    const mapped = mapHttpError(res, error);
    if (mapped) return mapped;

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
  const albumId = req.params.albumId as string;

  try {
    await deleteAlbumById(albumId);
    return res.status(200).json({
      message: 'Album supprimé avec succès'
    });
  } catch (error) {
    const mapped = mapHttpError(res, error);
    if (mapped) return mapped;

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
    const album = await fetchAlbumBySpotifyId(String(spotifyId));
    return res.status(200).json({ album });
  } catch (error) {
    const mapped = mapHttpError(res, error);
    if (mapped) return mapped;

    logger.error('Erreur lors de la récupération de l\'album par Spotify ID', {
      error: error instanceof Error ? error.message : 'Erreur inconnue',
      spotifyId
    });
    return res.status(500).json({
      message: 'Une erreur est survenue lors de la récupération de l\'album'
    });
  }
});
