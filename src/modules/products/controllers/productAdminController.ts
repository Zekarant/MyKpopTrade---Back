import { Request, Response } from 'express';
import { sendCsvFile, wantsCsv } from '../../../commons/utils/csv';
import { badRequest } from '../../../commons/utils/httpError';
import { parsePagination } from '../../../commons/utils/pagination';
import { queryString } from '../../../commons/utils/query';
import {
  AdminProductFilters,
  deleteProductAsAdmin,
  exportAdminProducts,
  getProductAdminStats as fetchProductAdminStats,
  listAdminProducts,
  reviewFlaggedProduct as reviewFlaggedProductAsAdmin
} from '../services/productAdminService';

/**
 * Liste tous les produits avec pagination et filtrage (admin)
 */
export const getAllProducts = async (req: Request, res: Response) => {
  const filters: AdminProductFilters = {
    search: queryString(req.query.search),
    status: queryString(req.query.status),
    type: queryString(req.query.type)
  };

  if (wantsCsv(req.query.format)) {
    return sendCsvFile(res, await exportAdminProducts(filters));
  }

  const result = await listAdminProducts(filters, parsePagination(req.query));
  return res.status(200).json(result);
};

/**
 * Statistiques produits pour l'admin
 */
export const getProductAdminStats = async (_req: Request, res: Response) => {
  return res.status(200).json(await fetchProductAdminStats());
};

/**
 * Supprimer un produit (admin)
 */
export const adminDeleteProduct = async (req: Request, res: Response) => {
  const { reason } = req.body ?? {};
  await deleteProductAsAdmin({
    productId: req.params.productId as string,
    adminId: req.user!.id,
    reason: typeof reason === 'string' ? reason : undefined
  });
  return res.status(200).json({ message: 'Produit supprimé par l\'administrateur' });
};

/**
 * Revue admin d'une annonce mise en pause par la modération IA.
 */
export const reviewFlaggedProduct = async (req: Request, res: Response) => {
  const { approve } = req.body ?? {};
  if (typeof approve !== 'boolean') {
    throw badRequest('approve (booléen) est requis');
  }

  const product = await reviewFlaggedProductAsAdmin({
    productId: req.params.productId as string,
    adminId: req.user!.id,
    approve
  });

  return res.status(200).json({
    message: approve ? 'Annonce republiée' : 'Signalement confirmé, annonce toujours en pause',
    product
  });
};
