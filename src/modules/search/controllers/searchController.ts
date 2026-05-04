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
    sortBy = 'relevance',
    includeOwnProducts = false
  }: SearchFilters & {
    page?: number;
    limit?: number;
    sortBy?: string;
    includeOwnProducts?: boolean;
  } = req.body;

  const userId = (req.user as any)?.id;

  try {
    const result = await runAdvancedSearch({
      filters: {
        query, groups, members, albums, priceRange,
        condition, type, albumType, era, company, currency
      },
      userId,
      includeOwnProducts,
      page,
      limit,
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
  const userId = (req.user as any).id;
  const limit = parseInt(req.query.limit as string) || 20;

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
  const userId = (req.user as any).id;
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
  const userId = (req.user as any).id;

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
