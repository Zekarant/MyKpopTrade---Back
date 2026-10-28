import { Request, Response } from 'express';
import {
  createProductForSeller,
  fetchProductById,
  listProducts,
  updateProductForOwner,
  removeProduct,
  markAsSold,
  toggleFavoriteForUser
} from '../services/productService';

/**
 * Créer un nouveau produit
 */
export const createProduct = async (req: Request, res: Response) => {
  const product = await createProductForSeller({
    sellerId: req.user!.id,
    productData: req.body,
    uploadedFiles: Array.isArray(req.files) ? req.files : undefined
  });

  return res.status(201).json({
    message: 'Produit créé avec succès',
    product
  });
};

/**
 * Récupérer un produit par son ID
 */
export const getProductById = async (req: Request, res: Response) => {
  const result = await fetchProductById(req.params.productId as string, req.user?.id);
  return res.status(200).json(result);
};

/**
 * Récupérer la liste des produits avec filtres et pagination
 */
export const getProducts = async (req: Request, res: Response) => {
  const result = await listProducts(req.query);
  return res.status(200).json(result);
};

/**
 * Mettre à jour un produit
 */
export const updateProduct = async (req: Request, res: Response) => {
  const product = await updateProductForOwner({
    productId: req.params.productId as string,
    userId: req.user!.id,
    body: req.body ?? {}
  });

  return res.status(200).json({
    message: 'Produit mis à jour avec succès',
    product
  });
};

/**
 * Supprimer un produit
 */
export const deleteProduct = async (req: Request, res: Response) => {
  const result = await removeProduct({
    productId: req.params.productId as string,
    userId: req.user!.id,
    soft: req.query.soft === 'true'
  });
  return res.status(200).json({
    message: result.soft ? 'Produit archivé avec succès' : 'Produit supprimé avec succès'
  });
};

/**
 * Marquer un produit comme vendu
 */
export const markProductAsSold = async (req: Request, res: Response) => {
  const product = await markAsSold({
    productId: req.params.productId as string,
    userId: req.user!.id,
    buyerId: req.body?.buyerId
  });
  return res.status(200).json({
    message: 'Produit marqué comme vendu avec succès',
    product
  });
};

/**
 * Ajouter/Retirer un produit des favoris
 */
export const toggleFavorite = async (req: Request, res: Response) => {
  const isFavorite = await toggleFavoriteForUser(req.user!.id, req.params.productId as string);
  return res.status(200).json({
    message: isFavorite ? 'Produit ajouté aux favoris' : 'Produit retiré des favoris',
    isFavorite
  });
};
