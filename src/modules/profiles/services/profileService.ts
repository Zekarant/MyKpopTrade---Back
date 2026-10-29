import mongoose from 'mongoose';
import path from 'path';
import fs from 'fs/promises';
import User, { IUser } from '../../../models/userModel';
import Product from '../../../models/productModel';
import Rating from '../../../models/ratingModel';
import { HttpError, userNotFound } from '../../../commons/utils/httpError';
import { USER_CARD_FIELDS } from '../../../commons/utils/userFields';

/**
 * Calcule le pourcentage de complétion du profil
 */
export const calculateProfileCompleteness = (user: IUser): number => {
  const fields = [
    { name: 'profilePicture', weight: 15 },
    { name: 'bio', weight: 15 },
    { name: 'location', weight: 10 },
    { name: 'preferences.kpopGroups', weight: 10, isArray: true },
    { name: 'socialLinks.instagram', weight: 5 },
    { name: 'socialLinks.twitter', weight: 5 },
    { name: 'socialLinks.discord', weight: 5 },
    { name: 'isEmailVerified', weight: 20, isBoolean: true },
    { name: 'isPhoneVerified', weight: 15, isBoolean: true }
  ];

  let completeness = 0;

  fields.forEach(field => {
    const segments = field.name.split('.');
    let value: unknown = user;

    for (const key of segments) {
      value = (value as Record<string, unknown> | null | undefined)?.[key];
      if (value === undefined) break;
    }

    if (field.isArray) {
      if (Array.isArray(value) && value.length > 0) {
        completeness += field.weight;
      }
    } else if (field.isBoolean) {
      if ((value as unknown) === true) {
        completeness += field.weight;
      }
    } else {
      if (value !== undefined && value !== null && String(value) !== '') {
        completeness += field.weight;
      }
    }
  });

  return completeness;
};

function resolveProjectPath(relativePath: string): string {
  return path.join(__dirname, '../../../../', relativePath.replace(/^\//, ''));
}

/** Supprime un fichier ; un fichier déjà absent n'est pas une erreur. */
async function removeFileIfExists(absolutePath: string): Promise<void> {
  await fs.rm(absolutePath, { force: true });
}


export async function fetchPublicProfile(identifier: string) {
  const isValidObjectId = mongoose.Types.ObjectId.isValid(identifier);

  const query: mongoose.QueryFilter<IUser> = { accountStatus: 'active' };
  if (isValidObjectId) {
    query._id = identifier;
  } else {
    query.username = identifier;
  }

  const user = await User.findOne(
    query,
    {
      _id: 1,
      username: 1,
      profilePicture: 1,
      profileBanner: 1,
      bio: 1,
      location: 1,
      socialLinks: 1,
      preferences: { kpopGroups: 1 },
      statistics: 1,
      isIdentityVerified: 1,
      isSellerVerified: 1,
      createdAt: 1
    }
  );

  if (!user) {
    throw new HttpError(404, 'Utilisateur non trouvé', 'USER_NOT_FOUND', {
      searchedBy: isValidObjectId ? 'ID' : 'username',
      searchedValue: identifier
    });
  }

  const [activeListings, recentRatings] = await Promise.all([
    Product.countDocuments({ seller: user._id, isAvailable: true }),
    Rating.find({ recipient: user._id })
      .populate('reviewer', USER_CARD_FIELDS)
      .sort({ createdAt: -1 })
      .limit(3)
      .select('rating review createdAt reviewer response')
      .lean()
  ]);

  return {
    profile: {
      id: user._id,
      username: user.username,
      profilePicture: user.profilePicture,
      profileBanner: user.profileBanner,
      bio: user.bio,
      location: user.location,
      socialLinks: user.socialLinks,
      isIdentityVerified: user.isIdentityVerified,
      isSellerVerified: user.isSellerVerified,
      kpopGroups: user.preferences?.kpopGroups || [],
      statistics: {
        ...user.toObject().statistics,
        activeListings
      },
      memberSince: user.createdAt,
      recentRatings
    }
  };
}

export async function fetchMyProfile(userId: string) {
  // Pas de lean() : les valeurs par défaut du schéma (photo, statistiques,
  // drapeaux de vérification) ne sont appliquées qu'aux documents hydratés.
  const user = await User.findById(userId);

  if (!user) {
    throw userNotFound();
  }

  const completenessPercentage = calculateProfileCompleteness(user);

  const [activeListings, soldItems, favoritedCount] = await Promise.all([
    Product.countDocuments({ seller: user._id, isAvailable: true }),
    Product.countDocuments({ seller: user._id, isAvailable: false }),
    Product.aggregate([
      { $match: { seller: user._id } },
      { $group: { _id: null, totalFavorites: { $sum: '$favorites' } } }
    ])
  ]);

  const totalFavorites = favoritedCount[0]?.totalFavorites || 0;

  return {
    profile: {
      id: user._id,
      username: user.username,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      role: user.role,
      profilePicture: user.profilePicture,
      profileBanner: user.profileBanner,
      phoneNumber: user.phoneNumber,
      isEmailVerified: user.isEmailVerified,
      isPhoneVerified: user.isPhoneVerified,
      bio: user.bio,
      location: user.location,
      socialLinks: user.socialLinks,
      preferences: user.preferences,
      statistics: {
        ...user.toObject().statistics,
        activeListings,
        soldItems,
        totalFavorites
      },
      memberSince: user.createdAt,
      accountStatus: user.accountStatus,
      lastLogin: user.lastLogin,
      completenessPercentage
    }
  };
}

type ProfileImageField = 'profilePicture' | 'profileBanner';

/**
 * Remplace la photo ou la bannière par le fichier déjà enregistré par l'upload,
 * puis supprime l'ancien fichier. En cas d'échec, le fichier reçu est supprimé.
 * @returns le chemin public de la nouvelle image
 */
export async function replaceProfileImage({
  userId,
  field,
  uploadDir,
  uploadedPath
}: {
  userId: string;
  field: ProfileImageField;
  uploadDir: 'profiles' | 'banners';
  uploadedPath: string;
}): Promise<string> {
  try {
    const user = await User.findById(userId);
    if (!user) {
      throw userNotFound();
    }

    const previous = user[field];
    const relativePath = `/uploads/${uploadDir}/${path.basename(uploadedPath)}`;
    user[field] = relativePath;
    await user.save();

    if (previous) {
      await removeFileIfExists(resolveProjectPath(previous));
    }
    return relativePath;
  } catch (error) {
    // Rien ne référence le fichier reçu : il resterait orphelin sur le disque.
    await removeFileIfExists(uploadedPath);
    throw error;
  }
}

/**
 * Retire la photo ou la bannière et supprime son fichier.
 * @throws HttpError 400 `missingMessage` si aucune image n'est définie
 */
export async function removeProfileImage({
  userId,
  field,
  missingMessage
}: {
  userId: string;
  field: ProfileImageField;
  missingMessage: string;
}): Promise<void> {
  const user = await User.findById(userId);
  if (!user) {
    throw userNotFound();
  }

  const current = user[field];
  if (!current) {
    throw new HttpError(400, missingMessage, 'NO_PROFILE_IMAGE');
  }

  user.set(field, undefined);
  await user.save();
  await removeFileIfExists(resolveProjectPath(current));
}
