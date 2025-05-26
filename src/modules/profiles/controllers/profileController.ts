import { Request, Response } from 'express';
import User from '../../../models/userModel';
import Product from '../../../models/productModel';
import Rating from '../../../models/ratingModel';
import { calculateProfileCompleteness } from '../services/profileService';
import { asyncHandler } from '../../../commons/middlewares/errorMiddleware';
import fs from 'fs';
import path from 'path';
import logger from '../../../commons/utils/logger';

/**
 * Récupérer le profil public d'un utilisateur
 */
export const getPublicProfile = asyncHandler(async (req: Request, res: Response) => {
  const { username } = req.params;
  
  const user = await User.findOne(
    { username, accountStatus: 'active' },
    {
      _id: 1,
      username: 1,
      profilePicture: 1,
      bio: 1,
      location: 1,
      socialLinks: 1,
      preferences: { kpopGroups: 1 },
      statistics: 1,
      createdAt: 1
    }
  );
  
  if (!user) {
    return res.status(404).json({ message: 'Utilisateur non trouvé' });
  }
  
  // Récupérer les statistiques de produits
  const activeListings = await Product.countDocuments({
    seller: user._id,
    isAvailable: true
  });
  
  return res.status(200).json({
    profile: {
      id: user._id,
      username: user.username,
      profilePicture: user.profilePicture,
      bio: user.bio,
      location: user.location,
      socialLinks: user.socialLinks,
      kpopGroups: user.preferences?.kpopGroups || [],
      statistics: {
        ...user.statistics?.toObject(),
        activeListings
      },
      memberSince: user.createdAt
    }
  });
});

/**
 * Récupérer les détails complets du profil (pour l'utilisateur connecté)
 */
export const getMyProfile = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  
  const user = await User.findById(userId);
  
  if (!user) {
    return res.status(404).json({ message: 'Utilisateur non trouvé' });
  }
  
  // Calculer le pourcentage de complétion du profil
  const completenessPercentage = calculateProfileCompleteness(user);
  
  // Récupérer les statistiques de produits
  const [activeListings, soldItems, favoritedCount] = await Promise.all([
    Product.countDocuments({ seller: user._id, isAvailable: true }),
    Product.countDocuments({ seller: user._id, isAvailable: false }),
    Product.aggregate([
      { $match: { seller: user._id } },
      { $group: { _id: null, totalFavorites: { $sum: '$favorites' } } }
    ])
  ]);
  
  const totalFavorites = favoritedCount[0]?.totalFavorites || 0;
  
  return res.status(200).json({
    profile: {
      id: user._id,
      username: user.username,
      email: user.email,
      profilePicture: user.profilePicture,
      phoneNumber: user.phoneNumber,
      isEmailVerified: user.isEmailVerified,
      isPhoneVerified: user.isPhoneVerified,
      bio: user.bio,
      location: user.location,
      socialLinks: user.socialLinks,
      preferences: user.preferences,
      statistics: {
        ...user.statistics?.toObject(),
        activeListings,
        soldItems,
        totalFavorites
      },
      memberSince: user.createdAt,
      accountStatus: user.accountStatus,
      lastLogin: user.lastLogin,
      completenessPercentage
    }
  });
});

/**
 * Mettre à jour mon profil
 */
export const updateProfile = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  
  const allowedUpdates = [
    'bio',
    'location',
    'socialLinks',
    'preferences'
  ];
  
  // Filtrer les champs permis
  const updates: Record<string, any> = {};
  for (const [key, value] of Object.entries(req.body)) {
    if (allowedUpdates.includes(key)) {
      updates[key] = value;
    }
  }
  
  // Valider la bio
  if (updates.bio && updates.bio.length > 500) {
    return res.status(400).json({ message: 'La bio ne peut pas dépasser 500 caractères' });
  }
  
  // Valider les liens sociaux
  if (updates.socialLinks) {
    // Validation des URLs en option
  }
  
  const user = await User.findByIdAndUpdate(
    userId,
    { $set: updates },
    { new: true, runValidators: true }
  );
  
  if (!user) {
    return res.status(404).json({ message: 'Utilisateur non trouvé' });
  }
  
  // Mettre à jour la date de dernière activité
  user.statistics = user.statistics || {};
  user.statistics.lastActive = new Date();
  await user.save();
  
  return res.status(200).json({
    message: 'Profil mis à jour avec succès',
    profile: {
      bio: user.bio,
      location: user.location,
      socialLinks: user.socialLinks,
      preferences: user.preferences
    }
  });
});

/**
 * Mettre à jour la photo de profil
 */
export const updateProfilePicture = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  
  if (!req.file) {
    return res.status(400).json({ message: 'Aucune image n\'a été téléchargée' });
  }
  
  try {
    // Récupérer l'utilisateur pour vérifier s'il a déjà une photo de profil
    const user = await User.findById(userId);
    
    if (!user) {
      return res.status(404).json({ message: 'Utilisateur non trouvé' });
    }
    
    // Chemin relatif pour stocker en base de données (sans le chemin absolu)
    const relativePath = `/uploads/profiles/${path.basename(req.file.path)}`;
    
    // Si l'utilisateur a déjà une photo de profil, supprimer l'ancienne
    if (user.profilePicture) {
      const oldPicturePath = path.join(
        __dirname, 
        '../../../../', 
        user.profilePicture.replace(/^\//, '')
      );
      
      // Vérifier si le fichier existe avant de le supprimer
      if (fs.existsSync(oldPicturePath)) {
        fs.unlinkSync(oldPicturePath);
      }
    }
    
    // Mettre à jour le profil avec le nouveau chemin d'image
    user.profilePicture = relativePath;
    await user.save();
    
    return res.status(200).json({
      message: 'Photo de profil mise à jour avec succès',
      profilePicture: user.profilePicture
    });
  } catch (error) {
    // En cas d'erreur, supprimer le fichier téléchargé
    if (req.file && req.file.path) {
      fs.unlinkSync(req.file.path);
    }
    
    logger.error('Erreur lors de la mise à jour de la photo de profil', { 
      error: error instanceof Error ? error.message : 'Erreur inconnue',
      userId 
    });
    
    return res.status(500).json({ 
      message: 'Une erreur est survenue lors de la mise à jour de la photo de profil' 
    });
  }
});

/**
 * Supprimer la photo de profil
 */
export const deleteProfilePicture = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  
  try {
    const user = await User.findById(userId);
    
    if (!user) {
      return res.status(404).json({ message: 'Utilisateur non trouvé' });
    }
    
    // Vérifier si l'utilisateur a une photo de profil
    if (!user.profilePicture) {
      return res.status(400).json({ message: 'Aucune photo de profil à supprimer' });
    }
    
    // Supprimer le fichier
    const picturePath = path.join(
      __dirname, 
      '../../../../', 
      user.profilePicture.replace(/^\//, '')
    );
    
    if (fs.existsSync(picturePath)) {
      fs.unlinkSync(picturePath);
    }
    
    // Mettre à jour le profil
    user.profilePicture = undefined;
    await user.save();
    
    return res.status(200).json({
      message: 'Photo de profil supprimée avec succès'
    });
  } catch (error) {
    logger.error('Erreur lors de la suppression de la photo de profil', { 
      error: error instanceof Error ? error.message : 'Erreur inconnue',
      userId 
    });
    
    return res.status(500).json({ 
      message: 'Une erreur est survenue lors de la suppression de la photo de profil' 
    });
  }
});

/**
 * Mettre à jour la bannière de profil
 */
export const updateProfileBanner = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  
  console.log('Headers:', req.headers);
  console.log('Files:', req.file || 'No file');
  console.log('Form data:', req.body);
  
  if (!req.file) {
    return res.status(400).json({ 
      message: 'Aucune image n\'a été téléchargée',
      debug: {
        contentType: req.headers['content-type'],
        hasFiles: !!req.files,
        fileInfo: req.file
      }
    });
  }
  
  try {
    // Récupérer l'utilisateur pour vérifier s'il a déjà une bannière
    const user = await User.findById(userId);
    
    if (!user) {
      return res.status(404).json({ message: 'Utilisateur non trouvé' });
    }
    
    // Chemin relatif pour stocker en base de données (sans le chemin absolu)
    const relativePath = `/uploads/banners/${path.basename(req.file.path)}`;
    
    // Si l'utilisateur a déjà une bannière, supprimer l'ancienne
    if (user.profileBanner) {
      const oldBannerPath = path.join(
        __dirname, 
        '../../../../', 
        user.profileBanner.replace(/^\//, '')
      );
      
      // Vérifier si le fichier existe avant de le supprimer
      if (fs.existsSync(oldBannerPath)) {
        fs.unlinkSync(oldBannerPath);
      }
    }
    
    // Mettre à jour le profil avec le nouveau chemin de bannière
    user.profileBanner = relativePath;
    await user.save();
    
    return res.status(200).json({
      message: 'Bannière de profil mise à jour avec succès',
      profileBanner: user.profileBanner
    });
  } catch (error) {
    // En cas d'erreur, supprimer le fichier téléchargé
    if (req.file && req.file.path) {
      fs.unlinkSync(req.file.path);
    }
    
    logger.error('Erreur lors de la mise à jour de la bannière de profil', { 
      error: error instanceof Error ? error.message : 'Erreur inconnue',
      userId 
    });
    
    return res.status(500).json({ 
      message: 'Une erreur est survenue lors de la mise à jour de la bannière de profil' 
    });
  }
});

/**
 * Supprimer la bannière de profil
 */
export const deleteProfileBanner = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  
  try {
    const user = await User.findById(userId);
    
    if (!user) {
      return res.status(404).json({ message: 'Utilisateur non trouvé' });
    }
    
    // Vérifier si l'utilisateur a une bannière de profil
    if (!user.profileBanner) {
      return res.status(400).json({ message: 'Aucune bannière de profil à supprimer' });
    }
    
    // Supprimer le fichier
    const bannerPath = path.join(
      __dirname, 
      '../../../../', 
      user.profileBanner.replace(/^\//, '')
    );
    
    if (fs.existsSync(bannerPath)) {
      fs.unlinkSync(bannerPath);
    }
    
    // Mettre à jour le profil
    user.profileBanner = undefined;
    await user.save();
    
    return res.status(200).json({
      message: 'Bannière de profil supprimée avec succès'
    });
  } catch (error) {
    logger.error('Erreur lors de la suppression de la bannière de profil', { 
      error: error instanceof Error ? error.message : 'Erreur inconnue',
      userId 
    });
    
    return res.status(500).json({ 
      message: 'Une erreur est survenue lors de la suppression de la bannière de profil' 
    });
  }
});