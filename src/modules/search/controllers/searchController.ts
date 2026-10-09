import { Request, Response } from 'express';
import { asyncHandler } from '../../../commons/middlewares/errorMiddleware';
import logger from '../../../commons/utils/logger';
import { mapHttpError } from '../../../commons/utils/httpErrorMapper';
import {
  SearchFilters,
  runAdvancedSearch,
  fetchUserSearchHistory,
  removeSearchHistoryItem,
  clearUserSearchHistory,
  fetchSearchSuggestions
} from '../services/searchService';
import { clampLimit, MAX_PAGE_SIZE } from '../../../commons/utils/pagination';

const DEFAULT_SEARCH_LIMIT = 20;
// La page de résultats du front demande jusqu'à 500 annonces d'un coup.
const MAX_SEARCH_LIMIT = 500;

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
    group,
    member,
    album,
    version,
    isOfficial,
    page = 1,
    limit = DEFAULT_SEARCH_LIMIT,
    sortBy = 'relevance',
    includeOwnProducts = false
  }: SearchFilters & {
    page?: number;
    limit?: number;
    sortBy?: string;
    includeOwnProducts?: boolean;
  } = req.body;

  const userId = req.user?.id;

  try {
    const result = await runAdvancedSearch({
      filters: {
        query, groups, members, albums, priceRange,
        condition, type, albumType, era, company, currency,
        group, member, album, version, isOfficial
      },
      userId,
      includeOwnProducts,
      page: Math.max(1, parseInt(String(page), 10) || 1),
      limit: clampLimit(limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT),
      sortBy
    });

    return res.status(200).json(result);
  } catch (error) {
    const mapped = mapHttpError(res, error);
    if (mapped) return mapped;

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
  const userId = req.user!.id;
  const limit = clampLimit(req.query.limit, 20, MAX_PAGE_SIZE);

  try {
    const searchHistory = await fetchUserSearchHistory(userId, limit);
    return res.status(200).json({ searchHistory });
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
  const userId = req.user!.id;
  const { historyId } = req.params;

  try {
    await removeSearchHistoryItem(userId, String(historyId));
    return res.status(200).json({
      message: 'Élément supprimé de l\'historique'
    });
  } catch (error) {
    const mapped = mapHttpError(res, error);
    if (mapped) return mapped;

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
  const userId = req.user!.id;

  try {
    await clearUserSearchHistory(userId);
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

  try {
    const suggestions = await fetchSearchSuggestions(query);
    return res.status(200).json({ suggestions });
  } catch (error) {
    const mapped = mapHttpError(res, error);
    if (mapped) return mapped;

    logger.error('Erreur lors de la génération des suggestions', {
      error: error instanceof Error ? error.message : 'Erreur inconnue',
      query
    });

    return res.status(500).json({
      message: 'Une erreur est survenue lors de la génération des suggestions'
    });
  }
});
