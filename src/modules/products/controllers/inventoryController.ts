import { Request, Response } from 'express';
import {
  fetchUserInventory,
  fetchUserFavorites,
  fetchRecommendedProducts,
  fetchQuickRecommendations,
  fetchProductStats
} from '../services/inventoryService';
import { clampLimit, MAX_PAGE_SIZE, parsePagination } from '../../../commons/utils/pagination';
import { queryString } from '../../../commons/utils/query';

const DEFAULT_RECOMMENDATIONS_LIMIT = 8;
const DEFAULT_QUICK_RECOMMENDATIONS_LIMIT = 4;

/**
 * Récupérer l'inventaire d'un utilisateur (produits en vente)
 */
export const getUserInventory = async (req: Request, res: Response) => {
  const { page, limit } = parsePagination(req.query);
  const result = await fetchUserInventory({
    sellerId: (req.params.userId || req.user!.id) as string,
    viewerId: req.user?.id,
    status: queryString(req.query.status) || 'available',
    page,
    limit
  });
  return res.status(200).json(result);
};

/**
 * Récupérer les produits favoris d'un utilisateur
 */
export const getUserFavorites = async (req: Request, res: Response) => {
  const { page, limit } = parsePagination(req.query);
  const result = await fetchUserFavorites(req.user!.id, page, limit);
  return res.status(200).json(result);
};

/**
 * Récupérer les produits recommandés
 */
export const getRecommendedProducts = async (req: Request, res: Response) => {
  const limit = clampLimit(req.query.limit, DEFAULT_RECOMMENDATIONS_LIMIT, MAX_PAGE_SIZE);
  const result = await fetchRecommendedProducts(req.user?.id, limit);
  return res.status(200).json(result);
};

/**
 * Récupérer des recommandations rapides
 */
export const getQuickRecommendations = async (req: Request, res: Response) => {
  const limit = clampLimit(req.query.limit, DEFAULT_QUICK_RECOMMENDATIONS_LIMIT, MAX_PAGE_SIZE);
  const products = await fetchQuickRecommendations(req.user?.id, limit);
  return res.status(200).json({ products });
};

/**
 * Récupérer les statistiques des produits
 */
export const getProductStats = async (_req: Request, res: Response) => {
  return res.status(200).json(await fetchProductStats());
};
