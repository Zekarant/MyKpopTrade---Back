import { Request, Response } from 'express';
import User from '../../../models/userModel';
import Product from '../../../models/productModel';
import Rating from '../../../models/ratingModel';
import { calculateProfileCompleteness } from '../services/profileService';
import { asyncHandler } from '../../../commons/middlewares/errorMiddleware';

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