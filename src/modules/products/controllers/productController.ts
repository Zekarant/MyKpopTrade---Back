import { Request, Response } from 'express';
import mongoose from 'mongoose';
import Product, { IProduct } from '../../../models/productModel';
import User from '../../../models/userModel';
import { asyncHandler } from '../../../commons/middlewares/errorMiddleware';
import { validateProductData } from '../services/productValidationService';
import logger from '../../../commons/utils/logger';
import path from 'path';
import fs from 'fs';

/**
 * Créer un nouveau produit
 */
export const createProduct = asyncHandler(async (req: Request, res: Response) => {
  const sellerId = (req.user as any).id;
  const productData = req.body;

  try {
    // Traiter les images téléchargées
    let imageUrls: string[] = [];

    // Si des fichiers ont été téléchargés
    if (req.files && Array.isArray(req.files) && req.files.length > 0) {
      // Convertir les fichiers en URLs pour le stockage
      imageUrls = (req.files as Express.Multer.File[]).map(file =>
        `/uploads/products/${path.basename(file.path)}`
      );
    }

    // Si des URLs d'image ont été fournies directement dans la requête (compatibilité avec l'ancien format)
    if (productData.images && Array.isArray(productData.images) && productData.images.length > 0) {
      // Si ce sont des chaînes JSON, les parser
      if (typeof productData.images === 'string') {
        try {
          const parsedImages = JSON.parse(productData.images);
          if (Array.isArray(parsedImages)) {
            imageUrls = [...imageUrls, ...parsedImages];
          }
        } catch (e) {
          // Si ce n'est pas du JSON valide, considérer comme une seule URL
          imageUrls.push(productData.images);
        }
      } else {
        // Sinon ajouter les URLs directement
        imageUrls = [...imageUrls, ...productData.images];
      }
    }


    // S'assurer qu'il y a au moins une image
    if (imageUrls.length === 0) {
      // Supprimer les fichiers téléchargés en cas d'erreur
      if (req.files && Array.isArray(req.files)) {
        (req.files as Express.Multer.File[]).forEach(file => {
          if (fs.existsSync(file.path)) {
            fs.unlinkSync(file.path);
          }
        });
      }

      return res.status(400).json({
        message: 'Au moins une image est requise pour créer un produit'
      });
    }

    // Remplacer les images dans les données du produit
    productData.images = imageUrls;
    // Parse shippingOptions si besoin (toujours avant la validation)
    if (typeof productData.shippingOptions === 'string') {
      try {
        productData.shippingOptions = JSON.parse(productData.shippingOptions);
      } catch (e) {
        return res.status(400).json({ message: 'shippingOptions est mal formé' });
      }
    }

    // Valider les données du produit
    const { error, value } = validateProductData(productData);
    if (error) {
      // Supprimer les fichiers téléchargés en cas d'erreur
      if (req.files && Array.isArray(req.files)) {
        (req.files as Express.Multer.File[]).forEach(file => {
          if (fs.existsSync(file.path)) {
            fs.unlinkSync(file.path);
          }
        });
      }

      return res.status(400).json({ message: error.details[0].message });
    }

    // Créer le produit
    const product = new Product({
      ...value,
      seller: sellerId,
      isAvailable: true,
      views: 0,
      favorites: 0
    });

    await product.save();

    // Mettre à jour les statistiques du vendeur
    await User.findByIdAndUpdate(sellerId, {
      $inc: { 'statistics.totalListings': 1 }
    });

    return res.status(201).json({
      message: 'Produit créé avec succès',
      product
    });
  } catch (error) {
    // En cas d'erreur, supprimer les fichiers téléchargés
    if (req.files && Array.isArray(req.files)) {
      (req.files as Express.Multer.File[]).forEach(file => {
        if (fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }
      });
    }

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
  const { productId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(productId)) {
    return res.status(400).json({ message: 'ID de produit invalide' });
  }

  const product = await Product.findById(productId)
    .populate('seller', 'username profilePicture statistics.averageRating statistics.totalRatings');

  if (!product) {
    return res.status(404).json({ message: 'Produit non trouvé' });
  }

  // Récupérer les noms du groupe et de l'album si ce sont des IDs
  let enrichedProduct: any = product.toObject();

  // Récupérer les informations du groupe Kpop
  if (product.kpopGroup) {
    const KpopGroup = (await import('../../../models/kpopGroupModel')).default;
    let group: any = null;

    // Vérifier si c'est un ObjectId ou un nom
    if (mongoose.Types.ObjectId.isValid(product.kpopGroup)) {
      group = await KpopGroup.findById(product.kpopGroup).select('_id name');
    } else {
      // Rechercher par nom
      group = await KpopGroup.findOne({ name: product.kpopGroup }).select('_id name');
    }

    if (group) {
      enrichedProduct.kpopGroupName = group.name;
      enrichedProduct.kpopGroupId = group._id.toString();
    }
  }

  // Récupérer les informations de l'album
  if (product.albumName) {
    const KpopAlbum = (await import('../../../models/albumModel')).default;
    let album: any = null;

    // Vérifier si c'est un ObjectId ou un nom
    if (mongoose.Types.ObjectId.isValid(product.albumName)) {
      album = await KpopAlbum.findById(product.albumName).select('_id name');
    } else {
      // Rechercher par nom (et potentiellement par artiste)
      album = await KpopAlbum.findOne({ name: product.albumName }).select('_id name');
    }

    if (album) {
      enrichedProduct.albumNameStr = album.name;
      enrichedProduct.albumId = album._id.toString();
    }
  }

  // Incrémenter le compteur de vues (sauf si c'est le vendeur qui consulte)
  const userId = (req.user as any)?.id;
  if (userId && userId !== product.seller._id.toString()) {
    product.views += 1;
    await product.save();
  }

  // Vérifier si l'utilisateur a mis ce produit en favoris
  let isFavorite = false;
  if (userId) {
    const user = await User.findById(userId, { favorites: 1 });
    if (user?.favorites?.includes(product._id)) {
      isFavorite = true;
    }
  }

  return res.status(200).json({
    product: enrichedProduct,
    isFavorite
  });
});

/**
 * Récupérer la liste des produits avec filtres et pagination
 */
export const getProducts = asyncHandler(async (req: Request, res: Response) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;
  const sort = req.query.sort || '-createdAt';

  // Construction des filtres
  const filter: any = { isAvailable: true };

  // Filtres de base
  if (req.query.seller) {
    filter.seller = req.query.seller;
  }

  if (req.query.type) {
    filter.type = req.query.type;
  }

  if (req.query.kpopGroup) {
    filter.kpopGroup = req.query.kpopGroup;
  }

  if (req.query.kpopMember) {
    filter.kpopMember = req.query.kpopMember;
  }

  // Filtre par fourchette de prix
  if (req.query.minPrice || req.query.maxPrice) {
    filter.price = {};
    if (req.query.minPrice) {
      filter.price.$gte = parseFloat(req.query.minPrice as string);
    }
    if (req.query.maxPrice) {
      filter.price.$lte = parseFloat(req.query.maxPrice as string);
    }
  }

  // Filtre par condition
  if (req.query.condition) {
    const conditions = (req.query.condition as string).split(',');
    if (conditions.length > 0) {
      filter.condition = { $in: conditions };
    }
  }

  // Recherche textuelle
  if (req.query.search) {
    filter.$text = { $search: req.query.search as string };
  }

  // Exécuter la requête avec pagination
  const [products, total] = await Promise.all([
    Product.find(filter)
      .populate('seller', 'username profilePicture')
      .sort(sort as string)
      .skip((page - 1) * limit)
      .limit(limit),
    Product.countDocuments(filter)
  ]);

  // Enrichir les produits avec les informations du groupe Kpop
  const enrichedProducts = await Promise.all(
    products.map(async (product) => {
      const enrichedProduct: any = product.toObject();

      // Récupérer les informations du groupe Kpop
      if (product.kpopGroup) {
        const KpopGroup = (await import('../../../models/kpopGroupModel')).default;
        let group: any = null;

        // Vérifier si c'est un ObjectId ou un nom
        if (mongoose.Types.ObjectId.isValid(product.kpopGroup)) {
          group = await KpopGroup.findById(product.kpopGroup).select('_id name');
        } else {
          // Rechercher par nom
          group = await KpopGroup.findOne({ name: product.kpopGroup }).select('_id name');
        }

        if (group) {
          enrichedProduct.kpopGroupName = group.name;
          enrichedProduct.kpopGroupId = group._id.toString();
        }
      }

      // Récupérer les informations de l'album
      if (product.albumName) {
        const KpopAlbum = (await import('../../../models/albumModel')).default;
        let album: any = null;

        // Vérifier si c'est un ObjectId ou un nom
        if (mongoose.Types.ObjectId.isValid(product.albumName)) {
          album = await KpopAlbum.findById(product.albumName).select('_id name');
        } else {
          // Rechercher par nom
          album = await KpopAlbum.findOne({ name: product.albumName }).select('_id name');
        }

        if (album) {
          enrichedProduct.albumNameStr = album.name;
          enrichedProduct.albumId = album._id.toString();
        }
      }

      return enrichedProduct;
    })
  );

  return res.status(200).json({
    products: enrichedProducts,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit)
    }
  });
});

/**
 * Mettre à jour un produit
 */
export const updateProduct = asyncHandler(async (req: Request, res: Response) => {
  const { productId } = req.params;
  const userId = (req.user as any).id;

  if (!mongoose.Types.ObjectId.isValid(productId)) {
    return res.status(400).json({ message: 'ID de produit invalide' });
  }

  const product = await Product.findById(productId);

  if (!product) {
    return res.status(404).json({ message: 'Produit non trouvé' });
  }

  // Vérifier que l'utilisateur est bien le propriétaire du produit
  if (product.seller.toString() !== userId) {
    return res.status(403).json({ message: 'Vous n\'êtes pas autorisé à modifier ce produit' });
  }

  // Liste des champs modifiables
  const allowedUpdates = [
    'title', 'description', 'price', 'currency', 'condition',
    'category', 'kpopGroup', 'kpopMember', 'albumName',
    'images', 'isAvailable', 'isReserved', 'reservedFor', 'shippingOptions'
  ];

  // Filtrer les champs autorisés
  const updates: Record<string, any> = {};
  for (const [key, value] of Object.entries(req.body)) {
    if (allowedUpdates.includes(key)) {
      updates[key] = value;
    }
  }

  // Si tentative de réservation, vérifier que l'utilisateur réservé existe
  if (updates.isReserved && updates.reservedFor) {
    const userExists = await User.exists({ _id: updates.reservedFor });
    if (!userExists) {
      return res.status(400).json({ message: 'Utilisateur réservé invalide' });
    }
  } else if (updates.isReserved === false) {
    // Si on annule la réservation, effacer aussi reservedFor
    updates.reservedFor = null;
  }

  // Valider les données de mise à jour
  const updatedProduct = await Product.findByIdAndUpdate(
    productId,
    { $set: updates },
    { new: true, runValidators: true }
  );

  return res.status(200).json({
    message: 'Produit mis à jour avec succès',
    product: updatedProduct
  });
});

/**
 * Supprimer un produit
 */
export const deleteProduct = asyncHandler(async (req: Request, res: Response) => {
  const { productId } = req.params;
  const userId = (req.user as any).id;

  if (!mongoose.Types.ObjectId.isValid(productId)) {
    return res.status(400).json({ message: 'ID de produit invalide' });
  }

  const product = await Product.findById(productId);

  if (!product) {
    return res.status(404).json({ message: 'Produit non trouvé' });
  }

  // Vérifier que l'utilisateur est bien le propriétaire du produit
  if (product.seller.toString() !== userId) {
    return res.status(403).json({ message: 'Vous n\'êtes pas autorisé à supprimer ce produit' });
  }

  // Soft delete: marquer comme indisponible plutôt que de supprimer
  if (req.query.soft === 'true') {
    product.isAvailable = false;
    await product.save();

    return res.status(200).json({
      message: 'Produit archivé avec succès'
    });
  }

  // Hard delete: supprimer complètement le produit
  await product.deleteOne();

  return res.status(200).json({
    message: 'Produit supprimé avec succès'
  });
});

/**
 * Marquer un produit comme vendu
 */
export const markProductAsSold = asyncHandler(async (req: Request, res: Response) => {
  const { productId } = req.params;
  const userId = (req.user as any).id;
  const { buyerId } = req.body;

  if (!mongoose.Types.ObjectId.isValid(productId)) {
    return res.status(400).json({ message: 'ID de produit invalide' });
  }

  const product = await Product.findById(productId);

  if (!product) {
    return res.status(404).json({ message: 'Produit non trouvé' });
  }

  // Vérifier que l'utilisateur est bien le propriétaire du produit
  if (product.seller.toString() !== userId) {
    return res.status(403).json({ message: 'Vous n\'êtes pas autorisé à modifier ce produit' });
  }

  // Si un acheteur est spécifié, vérifier qu'il existe
  if (buyerId && !mongoose.Types.ObjectId.isValid(buyerId)) {
    return res.status(400).json({ message: 'ID d\'acheteur invalide' });
  }

  // Marquer le produit comme vendu
  product.isAvailable = false;

  if (buyerId) {
    // Si on a spécifié un acheteur, on peut le stocker pour références futures
    // (nécessiterait un champ supplémentaire dans le modèle Product)
    // product.soldTo = buyerId;

    // Mise à jour des statistiques de l'acheteur
    await User.findByIdAndUpdate(buyerId, {
      $inc: { 'statistics.totalPurchases': 1 }
    });
  }

  // Mise à jour des statistiques du vendeur
  await User.findByIdAndUpdate(userId, {
    $inc: { 'statistics.totalSales': 1 }
  });

  await product.save();

  return res.status(200).json({
    message: 'Produit marqué comme vendu avec succès',
    product
  });
});

/**
 * Ajouter/Retirer un produit des favoris
 */
export const toggleFavorite = asyncHandler(async (req: Request, res: Response) => {
  const { productId } = req.params;
  const userId = (req.user as any).id;

  if (!mongoose.Types.ObjectId.isValid(productId)) {
    return res.status(400).json({ message: 'ID de produit invalide' });
  }

  const product = await Product.findById(productId);

  if (!product) {
    return res.status(404).json({ message: 'Produit non trouvé' });
  }

  // Vérifier si le produit est déjà dans les favoris
  const user = await User.findById(userId);
  if (!user) {
    return res.status(404).json({ message: 'Utilisateur non trouvé' });
  }

  // Initialiser le tableau des favoris s'il n'existe pas
  if (!user.favorites) {
    user.favorites = [];
  }

  const favoriteIndex = user.favorites.indexOf(product._id);
  let isFavorite = false;

  if (favoriteIndex === -1) {
    // Ajouter aux favoris
    user.favorites.push(product._id);
    product.favorites += 1;
    isFavorite = true;
  } else {
    // Retirer des favoris
    user.favorites.splice(favoriteIndex, 1);
    product.favorites = Math.max(0, product.favorites - 1);
    isFavorite = false;
  }

  await Promise.all([user.save(), product.save()]);

  return res.status(200).json({
    message: isFavorite ? 'Produit ajouté aux favoris' : 'Produit retiré des favoris',
    isFavorite
  });
});