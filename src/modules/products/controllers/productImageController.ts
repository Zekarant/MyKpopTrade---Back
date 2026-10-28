import { Request, Response } from 'express';
import { badRequest } from '../../../commons/utils/httpError';
import {
  addProductImage,
  deleteProductImage as removeProductImage,
  reorderProductImages as reorderImages
} from '../services/productImageService';

const isImageIndex = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;

/**
 * Télécharger une image pour un produit
 */
export const uploadProductImage = async (req: Request, res: Response) => {
  if (!req.file) {
    throw badRequest('Aucune image n\'a été téléchargée');
  }

  const { image, images } = await addProductImage({
    productId: req.params.productId as string,
    userId: req.user!.id,
    uploadedFilePath: req.file.path
  });

  return res.status(200).json({
    message: 'Image ajoutée avec succès',
    image,
    images
  });
};

/**
 * Supprimer une image d'un produit
 */
export const deleteProductImage = async (req: Request, res: Response) => {
  const { imageIndex } = req.body ?? {};
  if (!isImageIndex(imageIndex)) {
    throw badRequest('Index d\'image invalide');
  }

  const images = await removeProductImage({
    productId: req.params.productId as string,
    userId: req.user!.id,
    imageIndex
  });

  return res.status(200).json({
    message: 'Image supprimée avec succès',
    images
  });
};

/**
 * Réorganiser les images d'un produit
 */
export const reorderProductImages = async (req: Request, res: Response) => {
  const { imageOrder } = req.body ?? {};
  if (!Array.isArray(imageOrder) || imageOrder.some((index) => typeof index !== 'number')) {
    throw badRequest('Format de l\'ordre des images invalide');
  }

  const images = await reorderImages({
    productId: req.params.productId as string,
    userId: req.user!.id,
    imageOrder
  });

  return res.status(200).json({
    message: 'Ordre des images mis à jour avec succès',
    images
  });
};
