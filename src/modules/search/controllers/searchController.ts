import { Request, Response } from 'express';
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
const DEFAULT_HISTORY_LIMIT = 20;

/**
 * Recherche avancée de produits
 */
export const advancedSearch = async (req: Request, res: Response) => {
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
  } = req.body ?? {};

  const result = await runAdvancedSearch({
    filters: {
      query, groups, members, albums, priceRange,
      condition, type, albumType, era, company, currency,
      group, member, album, version, isOfficial
    },
    userId: req.user?.id,
    includeOwnProducts,
    // Corps JSON : `page` et `limit` arrivent en nombres, pas en texte de query.
    page: Math.max(1, parseInt(String(page), 10) || 1),
    limit: clampLimit(limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT),
    sortBy
  });

  return res.status(200).json(result);
};

/**
 * Récupérer l'historique de recherche d'un utilisateur
 */
export const getUserSearchHistory = async (req: Request, res: Response) => {
  const limit = clampLimit(req.query.limit, DEFAULT_HISTORY_LIMIT, MAX_PAGE_SIZE);
  const searchHistory = await fetchUserSearchHistory(req.user!.id, limit);
  return res.status(200).json({ searchHistory });
};

/**
 * Supprimer un élément de l'historique de recherche
 */
export const deleteSearchHistoryItem = async (req: Request, res: Response) => {
  await removeSearchHistoryItem(req.user!.id, String(req.params.historyId));
  return res.status(200).json({
    message: 'Élément supprimé de l\'historique'
  });
};

/**
 * Vider complètement l'historique de recherche
 */
export const clearSearchHistory = async (req: Request, res: Response) => {
  await clearUserSearchHistory(req.user!.id);
  return res.status(200).json({
    message: 'Historique de recherche vidé avec succès'
  });
};

/**
 * Obtenir des suggestions de recherche
 */
export const getSearchSuggestions = async (req: Request, res: Response) => {
  const suggestions = await fetchSearchSuggestions(req.query.query);
  return res.status(200).json({ suggestions });
};
