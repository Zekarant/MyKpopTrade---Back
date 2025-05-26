import { Request, Response } from 'express';
import mongoose from 'mongoose';
import Product from '../../../models/productModel';
import { asyncHandler } from '../../../commons/middlewares/errorMiddleware';
import fs from 'fs';
import path from 'path';
import logger from '../../../commons/utils/logger';

/**
 * Télécharger une image pour un produit
 */
export const uploadProductImage = asyncHandler(async (req: Request, res: Response) => {
  const { productId } = req.params;
  const userId = (req.user as any).id;
  
  if (!mongoose.Types.ObjectId.isValid(productId)) {
    return res.status(400).json({ message: 'ID de produit invalide' });
  }
  
  if (!req.file) {
    return res.status(400).json({ message: 'Aucune image n\'a été téléchargée' });
  }
  
  try {
    const product = await Product.findById(productId);
    
    if (!product) {
      // Supprimer le fichier téléchargé car le produit n'existe pas
      fs.unlinkSync(req.file.path);
      return res.status(404).json({ message: 'Produit non trouvé' });
    }
    
    // Vérifier que l'utilisateur est bien le propriétaire du produit
    if (product.seller.toString() !== userId) {
      // Supprimer le fichier téléchargé car l'utilisateur n'est pas autorisé
      fs.unlinkSync(req.file.path);
      return res.status(403).json({ message: 'Vous n\'êtes pas autorisé à modifier ce produit' });
    }
    
    // Chemin relatif pour stocker en base de données
    const relativePath = `/uploads/products/${path.basename(req.file.path)}`;
    
    // Ajouter l'image au tableau d'images du produit
    if (!product.images) {
      product.images = [];
    }
    
    // Vérifier si le nombre maximum d'images n'est pas dépassé
    if (product.images.length >= 10) {
      // Supprimer le fichier téléchargé car la limite est atteinte
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ message: 'Nombre maximum d\'images atteint (10)' });
    }
    
    product.images.push(relativePath);
    await product.save();
    
    return res.status(200).json({
      message: 'Image ajoutée avec succès',
      image: relativePath,
      images: product.images
    });
  } catch (error) {
    // En cas d'erreur, supprimer le fichier téléchargé
    if (req.file && req.file.path) {
      fs.unlinkSync(req.file.path);
    }
    
    logger.error('Erreur lors de l\'ajout d\'une image au produit', { 
      error: error instanceof Error ? error.message : 'Erreur inconnue',
      productId,
      userId 
    });
    
    return res.status(500).json({ 
      message: 'Une erreur est survenue lors de l\'ajout de l\'image' 
    });
  }
});

/**
 * Supprimer une image d'un produit
 */
export const deleteProductImage = asyncHandler(async (req: Request, res: Response) => {
  const { productId } = req.params;
  const { imageIndex } = req.body;
  const userId = (req.user as any).id;
  
  if (!mongoose.Types.ObjectId.isValid(productId)) {
    return res.status(400).json({ message: 'ID de produit invalide' });
  }
  
  // Validation de l'index
  if (typeof imageIndex !== 'number' || imageIndex < 0) {
    return res.status(400).json({ message: 'Index d\'image invalide' });
  }
  
  try {
    const product = await Product.findById(productId);
    
    if (!product) {
      return res.status(404).json({ message: 'Produit non trouvé' });
    }
    
    // Vérifier que l'utilisateur est bien le propriétaire du produit
    if (product.seller.toString() !== userId) {
      return res.status(403).json({ message: 'Vous n\'êtes pas autorisé à modifier ce produit' });
    }
    
    // Vérifier que l'index est valide
    if (!product.images || imageIndex >= product.images.length) {
      return res.status(400).json({ message: 'Index d\'image invalide' });
    }
    
    // Vérifier qu'il reste au moins une image
    if (product.images.length <= 1) {
      return res.status(400).json({ message: 'Impossible de supprimer la dernière image du produit' });
    }
    
    // Récupérer le chemin de l'image à supprimer
    const imagePath = product.images[imageIndex];
    
    // Supprimer le fichier
    const fullPath = path.join(
      __dirname, 
      '../../../../', 
      imagePath.replace(/^\//, '')
    );
    
    if (fs.existsSync(fullPath)) {
      fs.unlinkSync(fullPath);
    }
    
    // Supprimer l'image du tableau
    product.images.splice(imageIndex, 1);
    await product.save();
    
    return res.status(200).json({
      message: 'Image supprimée avec succès',
      images: product.images
    });
  } catch (error) {
    logger.error('Erreur lors de la suppression d\'une image du produit', { 
      error: error instanceof Error ? error.message : 'Erreur inconnue',
      productId,
      userId 
    });
    
    return res.status(500).json({ 
      message: 'Une erreur est survenue lors de la suppression de l\'image' 
    });
  }
});

/**
 * Réorganiser les images d'un produit
 */
export const reorderProductImages = asyncHandler(async (req: Request, res: Response) => {
  const { productId } = req.params;
  const { imageOrder } = req.body;
  const userId = (req.user as any).id;
  
  if (!mongoose.Types.ObjectId.isValid(productId)) {
    return res.status(400).json({ message: 'ID de produit invalide' });
  }
  
  // Validation de l'ordre des images
  if (!Array.isArray(imageOrder) || imageOrder.some(i => typeof i !== 'number')) {
    return res.status(400).json({ message: 'Format de l\'ordre des images invalide' });
  }
  
  try {
    const product = await Product.findById(productId);
    
    if (!product) {
      return res.status(404).json({ message: 'Produit non trouvé' });
    }
    
    // Vérifier que l'utilisateur est bien le propriétaire du produit
    if (product.seller.toString() !== userId) {
      return res.status(403).json({ message: 'Vous n\'êtes pas autorisé à modifier ce produit' });
    }
    
    // Vérifier que les indices sont valides
    if (!product.images || imageOrder.length !== product.images.length || 
        imageOrder.some(i => i < 0 || i >= product.images.length)) {
      return res.status(400).json({ message: 'Ordre des images invalide' });
    }
    
    // Réorganiser les images
    const newImagesOrder = imageOrder.map(index => product.images[index]);
    product.images = newImagesOrder;
    await product.save();
    
    return res.status(200).json({
      message: 'Ordre des images mis à jour avec succès',
      images: product.images
    });
  } catch (error) {
    logger.error('Erreur lors de la réorganisation des images du produit', { 
      error: error instanceof Error ? error.message : 'Erreur inconnue',
      productId,
      userId 
    });
    
    return res.status(500).json({ 
      message: 'Une erreur est survenue lors de la réorganisation des images' 
    });
  }
});