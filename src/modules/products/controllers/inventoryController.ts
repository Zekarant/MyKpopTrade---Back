import { Request, Response } from 'express';
import { asyncHandler } from '../../../commons/middlewares/errorMiddleware';
import {
  fetchUserInventory,
  fetchUserFavorites,
  fetchRecommendedProducts,
  fetchQuickRecommendations,
  fetchProductStats
} from '../services/inventoryService';
import { clampLimit, MAX_PAGE_SIZE } from '../../../commons/utils/pagination';

/**
 * Récupérer l'inventaire d'un utilisateur (produits en vente)
 */
export const getUserInventory = asyncHandler(async (req: Request, res: Response) => {
  const sellerId = (req.params.userId || (req.user as any).id) as string;
  const viewerId = (req.user as any)?.id;
  const page = parseInt(req.query.page as string) || 1;
  const limit = clampLimit(req.query.limit, 20, MAX_PAGE_SIZE);
  const status = (req.query.status as string) || 'available';

  const result = await fetchUserInventory({ sellerId, viewerId, status, page, limit });
  return res.status(200).json(result);
});

/**
 * Récupérer les produits favoris d'un utilisateur
 */
export const getUserFavorites = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const page = parseInt(req.query.page as string) || 1;
  const limit = clampLimit(req.query.limit, 20, MAX_PAGE_SIZE);

  const result = await fetchUserFavorites(userId, page, limit);
  return res.status(200).json(result);
});

/**
 * Récupérer les produits recommandés
 */
export const getRecommendedProducts = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any)?.id;
  const limit = clampLimit(req.query.limit, 8, MAX_PAGE_SIZE);

  const result = await fetchRecommendedProducts(userId, limit);
  return res.status(200).json(result);
});

/**
 * Récupérer des recommandations rapides
 */
export const getQuickRecommendations = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any)?.id;
  const limit = clampLimit(req.query.limit, 4, MAX_PAGE_SIZE);

  const products = await fetchQuickRecommendations(userId, limit);
  return res.status(200).json({ products });
});

/**
 * Récupérer les statistiques des produits
 */
export const getProductStats = asyncHandler(async (req: Request, res: Response) => {
  const result = await fetchProductStats();
  return res.status(200).json(result);
});
