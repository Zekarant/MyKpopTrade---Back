import { Request, Response } from 'express';
import fs from 'fs';
import { asyncHandler } from '../../../commons/middlewares/errorMiddleware';
import logger from '../../../commons/utils/logger';
import { mapHttpError } from '../../../commons/utils/httpErrorMapper';
import {
  resolveProductImages,
  createProductForSeller,
  fetchProductById,
  listProducts,
  updateProductForOwner,
  removeProduct,
  markAsSold,
  toggleFavoriteForUser
} from '../services/productService';

function cleanupFiles(files?: any) {
  if (files && Array.isArray(files)) {
    (files as Express.Multer.File[]).forEach(file => {
      if (fs.existsSync(file.path)) {
        fs.unlinkSync(file.path);
      }
    });
  }
}

/**
 * Créer un nouveau produit
 */
export const createProduct = asyncHandler(async (req: Request, res: Response) => {
  const sellerId = (req.user as any).id;
  const productData = req.body;

  const imageUrls = resolveProductImages(req);
  const uploadedFiles = Array.isArray(req.files) ? req.files as Express.Multer.File[] : undefined;

  try {
    const product = await createProductForSeller({
      sellerId,
      productData,
      imageUrls,
      uploadedFiles
    });

    return res.status(201).json({
      message: 'Produit créé avec succès',
      product
    });
  } catch (error) {
    const mapped = mapHttpError(res, error);
    if (mapped) return mapped;

    cleanupFiles(req.files);

    logger.error('Erreur lors de la création du produit', {
      error: error instanceof Error ? error.message : 'Erreur inconnue',
      userId: sellerId
    });

    return res.status(500).json({
      message: 'Une erreur est survenue lors de la création du produit'
    });
  }
});

/**
 * Récupérer un produit par son ID
 */
export const getProductById = asyncHandler(async (req: Request, res: Response) => {
  const productId = req.params.productId as string;
  const userId = (req.user as any)?.id;

  try {
    const result = await fetchProductById(productId, userId);
    return res.status(200).json(result);
  } catch (error) {
    const mapped = mapHttpError(res, error);
    if (mapped) return mapped;
    throw error;
  }
});

/**
 * Récupérer la liste des produits avec filtres et pagination
 */
export const getProducts = asyncHandler(async (req: Request, res: Response) => {
  const result = await listProducts(req.query);
  return res.status(200).json(result);
});

/**
 * Mettre à jour un produit
 */
export const updateProduct = asyncHandler(async (req: Request, res: Response) => {
  const productId = req.params.productId as string;
  const userId = (req.user as any).id;

  try {
    const product = await updateProductForOwner({
      productId,
      userId,
      body: req.body
    });

    return res.status(200).json({
      message: 'Produit mis à jour avec succès',
      product
    });
  } catch (error) {
    const mapped = mapHttpError(res, error);
    if (mapped) return mapped;
    throw error;
  }
});

/**
 * Supprimer un produit
 */
export const deleteProduct = asyncHandler(async (req: Request, res: Response) => {
  const productId = req.params.productId as string;
  const userId = (req.user as any).id;
  const soft = req.query.soft === 'true';

  try {
    const result = await removeProduct({ productId, userId, soft });
    return res.status(200).json({
      message: result.soft ? 'Produit archivé avec succès' : 'Produit supprimé avec succès'
    });
  } catch (error) {
    const mapped = mapHttpError(res, error);
    if (mapped) return mapped;
    throw error;
  }
});

/**
 * Marquer un produit comme vendu
 */
export const markProductAsSold = asyncHandler(async (req: Request, res: Response) => {
  const productId = req.params.productId as string;
  const userId = (req.user as any).id;
  const { buyerId } = req.body;

  try {
    const product = await markAsSold({ productId, userId, buyerId });
    return res.status(200).json({
      message: 'Produit marqué comme vendu avec succès',
      product
    });
  } catch (error) {
    const mapped = mapHttpError(res, error);
    if (mapped) return mapped;
    throw error;
  }
});

/**
 * Ajouter/Retirer un produit des favoris
 */
export const toggleFavorite = asyncHandler(async (req: Request, res: Response) => {
  const productId = req.params.productId as string;
  const userId = (req.user as any).id;

  try {
    const isFavorite = await toggleFavoriteForUser(userId, productId);
    return res.status(200).json({
      message: isFavorite ? 'Produit ajouté aux favoris' : 'Produit retiré des favoris',
      isFavorite
    });
  } catch (error) {
    const mapped = mapHttpError(res, error);
    if (mapped) return mapped;
    throw error;
  }
});
