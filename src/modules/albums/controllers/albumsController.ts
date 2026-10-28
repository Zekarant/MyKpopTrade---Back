import { Request, Response } from 'express';
import {
  createAlbumForGroup,
  listAlbums,
  fetchAlbumById,
  fetchAlbumsByGroup,
  searchAlbumsByQuery,
  updateAlbumById,
  deleteAlbumById
} from '../services/albumsService';
import { clampLimit, parsePagination, MAX_PAGE_SIZE } from '../../../commons/utils/pagination';
import { queryInt, queryString } from '../../../commons/utils/query';

const DEFAULT_LIMIT = 20;
/** Le panneau admin K-pop charge jusqu'à 2000 albums d'un coup. */
const CATALOG_MAX_LIMIT = 2000;

/** Entier optionnel de la query : absent ou invalide → pas de filtre. */
function optionalInt(value: unknown): number | undefined {
  const parsed = queryInt(value);
  return isNaN(parsed) ? undefined : parsed;
}

/**
 * Créer un nouvel album (Admin uniquement)
 */
export const createAlbum = async (req: Request, res: Response) => {
  const album = await createAlbumForGroup(req.body ?? {});
  res.status(201).json({
    message: 'Album créé avec succès',
    album
  });
};

/**
 * Récupérer tous les albums avec pagination et filtres
 */
export const getAlbums = async (req: Request, res: Response) => {
  const { page, limit } = parsePagination(req.query, { defaultLimit: DEFAULT_LIMIT, maxLimit: CATALOG_MAX_LIMIT });

  const result = await listAlbums({
    page,
    limit,
    sortBy: queryString(req.query.sortBy) || 'releaseDate',
    sortOrder: req.query.sortOrder === 'asc' ? 1 : -1,
    artistId: queryString(req.query.artistId),
    artistName: queryString(req.query.artistName),
    search: queryString(req.query.search),
    minTracks: optionalInt(req.query.minTracks),
    year: optionalInt(req.query.year)
  });
  res.status(200).json(result);
};

/**
 * Récupérer un album par son ID avec produits disponibles
 */
export const getAlbumById = async (req: Request, res: Response) => {
  const result = await fetchAlbumById(req.params.albumId as string);
  res.status(200).json(result);
};

/**
 * Récupérer les albums d'un groupe
 */
export const getAlbumsByGroup = async (req: Request, res: Response) => {
  const { albums, empty } = await fetchAlbumsByGroup(req.params.groupId as string);

  if (empty) {
    res.status(200).json({
      albums: [],
      message: 'Aucun album trouvé pour ce groupe'
    });
    return;
  }

  res.status(200).json({ albums });
};

/**
 * Recherche d'albums par nom ou artiste
 */
export const searchAlbums = async (req: Request, res: Response) => {
  const result = await searchAlbumsByQuery({
    query: queryString(req.query.query),
    limit: clampLimit(req.query.limit, DEFAULT_LIMIT, MAX_PAGE_SIZE)
  });
  res.status(200).json(result);
};

/**
 * Mettre à jour un album (Admin uniquement)
 */
export const updateAlbum = async (req: Request, res: Response) => {
  const album = await updateAlbumById(req.params.albumId as string, req.body ?? {});
  res.status(200).json({
    message: 'Album mis à jour avec succès',
    album
  });
};

/**
 * Supprimer un album (Admin uniquement)
 */
export const deleteAlbum = async (req: Request, res: Response) => {
  await deleteAlbumById(req.params.albumId as string);
  res.status(200).json({
    message: 'Album supprimé avec succès'
  });
};
