import mongoose from 'mongoose';
import path from 'path';
import fs from 'fs';
import User, { IUser } from '../../../models/userModel';
import Product from '../../../models/productModel';
import Rating from '../../../models/ratingModel';
import { HttpError } from '../../../commons/utils/httpError';

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
    let value: any = user;

    for (const key of segments) {
      value = value?.[key as keyof typeof value];
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

function removeFileIfExists(absolutePath: string) {
  if (fs.existsSync(absolutePath)) {
    fs.unlinkSync(absolutePath);
  }
}

export async function fetchPublicProfile(identifier: string) {
  const isValidObjectId = mongoose.Types.ObjectId.isValid(identifier);

  const query: any = { accountStatus: 'active' };
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
      createdAt: 1
    }
  );

  if (!user) {
    const err = new HttpError(404, 'Utilisateur non trouvé');
    (err as any).details = {
      searchedBy: isValidObjectId ? 'ID' : 'username',
      searchedValue: identifier
    };
    throw err;
  }

  const activeListings = await Product.countDocuments({
    seller: user._id,
    isAvailable: true
  });

  const recentRatings = await Rating.find({ recipient: user._id })
    .populate('reviewer', 'username profilePicture')
    .sort({ createdAt: -1 })
    .limit(3)
    .select('rating review createdAt reviewer response');

  return {
    profile: {
      id: user._id,
      username: user.username,
      profilePicture: user.profilePicture,
      profileBanner: user.profileBanner,
      bio: user.bio,
      location: user.location,
      socialLinks: user.socialLinks,
      kpopGroups: user.preferences?.kpopGroups || [],
      statistics: {
        ...user.statistics?.toObject(),
        activeListings
      },
      memberSince: user.createdAt,
      recentRatings
    }
  };
}

export async function fetchMyProfile(userId: string) {
  const user = await User.findById(userId);

  if (!user) {
    throw new HttpError(404, 'Utilisateur non trouvé');
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
      email: user.email,
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
  };
}

export async function updateMyProfile(userId: string, body: Record<string, any>) {
  const allowedUpdates = ['bio', 'location', 'socialLinks', 'preferences'];

  const updates: Record<string, any> = {};
  for (const [key, value] of Object.entries(body)) {
    if (allowedUpdates.includes(key)) {
      updates[key] = value;
    }
  }

  if (updates.bio && updates.bio.length > 500) {
    throw new HttpError(400, 'La bio ne peut pas dépasser 500 caractères');
  }

  const user = await User.findByIdAndUpdate(
    userId,
    { $set: updates },
    { new: true, runValidators: true }
  );

  if (!user) {
    throw new HttpError(404, 'Utilisateur non trouvé');
  }

  user.statistics = user.statistics || {};
  user.statistics.lastActive = new Date();
  await user.save();

  return {
    bio: user.bio,
    location: user.location,
    socialLinks: user.socialLinks,
    preferences: user.preferences
  };
}

type ProfileImageField = 'profilePicture' | 'profileBanner';

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
  const user = await User.findById(userId);

  if (!user) {
    throw new HttpError(404, 'Utilisateur non trouvé');
  }

  const relativePath = `/uploads/${uploadDir}/${path.basename(uploadedPath)}`;

  const previous = user[field];
  if (previous) {
    removeFileIfExists(resolveProjectPath(previous));
  }

  user[field] = relativePath;
  await user.save();

  return relativePath;
}

export async function removeProfileImage({
  userId,
  field,
  missingMessage
}: {
  userId: string;
  field: ProfileImageField;
  missingMessage: string;
}) {
  const user = await User.findById(userId);

  if (!user) {
    throw new HttpError(404, 'Utilisateur non trouvé');
  }

  if (!user[field]) {
    throw new HttpError(400, missingMessage);
  }

  removeFileIfExists(resolveProjectPath(user[field] as string));

  user[field] = undefined;
  await user.save();
}
