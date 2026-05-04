import mongoose from 'mongoose';
import path from 'path';
import fs from 'fs';
import Rating from '../../../models/ratingModel';
import User from '../../../models/userModel';
import { HttpError } from '../../../commons/utils/httpError';
import { NotificationService } from '../../notifications/services/notificationService';

const EMPTY_DISTRIBUTION = { '5': 0, '4': 0, '3': 0, '2': 0, '1': 0 };

const RATING_MIN = 1;
const RATING_MAX = 5;
const MAX_IMAGES_PER_RATING = 5;
const MAX_RESPONSE_LENGTH = 500;
const STAR_KEY_BY_RATING: Record<number, string> = {
  5: 'fiveStars',
  4: 'fourStars',
  3: 'threeStars',
  2: 'twoStars',
  1: 'oneStars'
};

/**
 * Met à jour la note moyenne d'un utilisateur
 */
export const updateUserAverageRating = async (userId: string): Promise<void> => {
  const result = await Rating.aggregate([
    { $match: { recipient: new mongoose.Types.ObjectId(userId), isHidden: false } },
    {
      $group: {
        _id: null,
        averageRating: { $avg: '$rating' },
        totalCount: { $sum: 1 }
      }
    }
  ]);

  const averageRating = result.length > 0 ? parseFloat(result[0].averageRating.toFixed(2)) : 0;
  const totalRatings = result.length > 0 ? result[0].totalCount : 0;

  await User.findByIdAndUpdate(userId, {
    $set: {
      'statistics.averageRating': averageRating,
      'statistics.totalRatings': totalRatings
    }
  });
};

/**
 * Supprime les fichiers listés (accepte des chemins absolus ou relatifs à la racine projet).
 */
export function cleanupRatingImages(imagePaths: string[]): void {
  for (const imagePath of imagePaths) {
    const fullPath = path.isAbsolute(imagePath)
      ? imagePath
      : path.join(__dirname, '../../../../', imagePath.replace(/^\//, ''));
    if (fs.existsSync(fullPath)) {
      fs.unlinkSync(fullPath);
    }
  }
}

export async function getUserRatingsWithStats(
  userId: string,
  type: string | undefined,
  page: number,
  limit: number
) {
  const filter: any = { recipient: userId, isHidden: false };

  if (type === 'buyer' || type === 'seller') {
    filter.type = type;
  }

  const [ratings, count] = await Promise.all([
    Rating.find(filter)
      .populate('reviewer', 'username profilePicture')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Rating.countDocuments(filter)
  ]);

  const starAggregations: Record<string, any> = {};
  for (const [score, key] of Object.entries(STAR_KEY_BY_RATING)) {
    starAggregations[key] = { $sum: { $cond: [{ $eq: ['$rating', Number(score)] }, 1, 0] } };
  }

  const stats = await Rating.aggregate([
    { $match: { recipient: new mongoose.Types.ObjectId(userId), isHidden: false } },
    {
      $group: {
        _id: null,
        averageRating: { $avg: '$rating' },
        totalRatings: { $sum: 1 },
        ...starAggregations
      }
    }
  ]);

  const ratingStats = stats.length > 0 ? {
    averageRating: parseFloat(stats[0].averageRating.toFixed(2)),
    totalRatings: stats[0].totalRatings,
    fiveStars: stats[0].fiveStars,
    fourStars: stats[0].fourStars,
    threeStars: stats[0].threeStars,
    twoStars: stats[0].twoStars,
    oneStars: stats[0].oneStars,
    distribution: Object.fromEntries(
      Object.entries(STAR_KEY_BY_RATING).map(([score, key]) => [score, stats[0][key]])
    )
  } : {
    averageRating: 0,
    totalRatings: 0,
    distribution: { ...EMPTY_DISTRIBUTION }
  };

  return {
    ratings,
    stats: ratingStats,
    pagination: {
      page,
      limit,
      totalItems: count,
      totalPages: Math.ceil(count / limit)
    }
  };
}

export async function createUserRating({
  reviewerId,
  recipientId,
  rating,
  review,
  type,
  transactionId,
  images
}: {
  reviewerId: string;
  recipientId: string;
  rating: number;
  review: string;
  type: string;
  transactionId?: string;
  images: string[];
}) {
  const fail = (status: number, message: string): never => {
    cleanupRatingImages(images);
    throw new HttpError(status, message);
  };

  if (!recipientId || isNaN(rating) || !review || !type) {
    fail(400, 'Tous les champs sont obligatoires');
  }

  if (rating < RATING_MIN || rating > RATING_MAX || !Number.isInteger(rating)) {
    fail(400, `La note doit être un entier entre ${RATING_MIN} et ${RATING_MAX}`);
  }

  if (type !== 'buyer' && type !== 'seller') {
    fail(400, 'Le type doit être "buyer" ou "seller"');
  }

  const recipient = await User.findById(recipientId);
  if (!recipient) {
    fail(404, 'Utilisateur destinataire non trouvé');
  }

  if (reviewerId === recipientId) {
    fail(400, 'Vous ne pouvez pas vous auto-évaluer');
  }

  if (transactionId) {
    const existingRating = await Rating.findOne({
      reviewer: reviewerId,
      transaction: transactionId
    });

    if (existingRating) {
      fail(400, 'Vous avez déjà laissé une évaluation pour cette transaction');
    }
  }

  const newRating = new Rating({
    reviewer: reviewerId,
    recipient: recipientId,
    rating,
    review,
    type,
    transaction: transactionId,
    isVerifiedPurchase: Boolean(transactionId),
    images
  });

  await newRating.save();

  await updateUserAverageRating(recipientId);

  const reviewer = await User.findById(reviewerId).select('username').lean() as { username?: string } | null;
  await NotificationService.createNotification({
    recipientId,
    type: 'rating_received',
    title: 'Nouvelle évaluation',
    content: `${reviewer?.username || 'Un utilisateur'} vous a noté ${rating}/5`,
    link: `/adherents/profile/me`,
    data: { ratingId: newRating._id, reviewerId, rating }
  }).catch(() => undefined);

  return await Rating.findById(newRating._id).populate('reviewer', 'username profilePicture');
}

export async function reportUserRating(userId: string, ratingId: string, reason: string) {
  if (!reason) {
    throw new HttpError(400, 'Veuillez indiquer la raison du signalement');
  }

  const rating = await Rating.findById(ratingId);

  if (!rating) {
    throw new HttpError(404, 'Évaluation non trouvée');
  }

  if (rating.recipient.toString() !== userId && rating.reviewer.toString() !== userId) {
    throw new HttpError(403, 'Vous n\'êtes pas autorisé à signaler cette évaluation');
  }
}

export async function deleteRatingImageAt({
  userId,
  ratingId,
  imageIndex
}: {
  userId: string;
  ratingId: string;
  imageIndex: number;
}): Promise<string[]> {
  if (typeof imageIndex !== 'number' || imageIndex < 0) {
    throw new HttpError(400, 'Index d\'image invalide');
  }

  const rating = await Rating.findById(ratingId);

  if (!rating) {
    throw new HttpError(404, 'Évaluation non trouvée');
  }

  if (rating.reviewer.toString() !== userId) {
    throw new HttpError(403, 'Vous n\'êtes pas autorisé à modifier cette évaluation');
  }

  if (!rating.images || imageIndex >= rating.images.length) {
    throw new HttpError(400, 'Index d\'image invalide');
  }

  const imagePath = rating.images[imageIndex];
  cleanupRatingImages([imagePath]);

  rating.images.splice(imageIndex, 1);
  await rating.save();

  return rating.images;
}

export async function addRatingImageForUser({
  userId,
  ratingId,
  filePath
}: {
  userId: string;
  ratingId: string;
  filePath: string;
}): Promise<{ image: string; images: string[] }> {
  const rating = await Rating.findById(ratingId);

  if (!rating) {
    cleanupRatingImages([filePath]);
    throw new HttpError(404, 'Évaluation non trouvée');
  }

  if (rating.reviewer.toString() !== userId) {
    cleanupRatingImages([filePath]);
    throw new HttpError(403, 'Vous n\'êtes pas autorisé à modifier cette évaluation');
  }

  if (!rating.images) {
    rating.images = [];
  }

  if (rating.images.length >= MAX_IMAGES_PER_RATING) {
    cleanupRatingImages([filePath]);
    throw new HttpError(400, `Nombre maximum d'images atteint (${MAX_IMAGES_PER_RATING})`);
  }

  const relativePath = `/uploads/ratings/${path.basename(filePath)}`;
  rating.images.push(relativePath);
  await rating.save();

  return {
    image: relativePath,
    images: rating.images
  };
}

async function loadRatingForRecipient(userId: string, ratingId: string, permissionMsg: string) {
  const rating = await Rating.findById(ratingId);

  if (!rating) {
    throw new HttpError(404, 'Évaluation non trouvée');
  }

  if (rating.recipient.toString() !== userId) {
    throw new HttpError(403, permissionMsg);
  }

  return rating;
}

function validateResponseContent(response: unknown): string {
  if (!response || typeof response !== 'string' || response.trim() === '') {
    throw new HttpError(400, 'Le contenu de la réponse est requis');
  }

  if (response.length > MAX_RESPONSE_LENGTH) {
    throw new HttpError(400, `La réponse ne peut pas dépasser ${MAX_RESPONSE_LENGTH} caractères`);
  }

  return response.trim();
}

export async function respondToUserRating(userId: string, ratingId: string, response: unknown) {
  const trimmed = validateResponseContent(response);

  const rating = await loadRatingForRecipient(
    userId,
    ratingId,
    'Seul le destinataire de l\'évaluation peut y répondre'
  );

  if (rating.response && rating.response.content) {
    throw new HttpError(400, 'Vous avez déjà répondu à cette évaluation');
  }

  rating.response = {
    content: trimmed,
    createdAt: new Date()
  };

  await rating.save();

  return rating;
}

export async function updateUserRatingResponse(userId: string, ratingId: string, response: unknown) {
  const trimmed = validateResponseContent(response);

  const rating = await loadRatingForRecipient(
    userId,
    ratingId,
    'Seul le destinataire de l\'évaluation peut modifier sa réponse'
  );

  if (!rating.response || !rating.response.content) {
    throw new HttpError(400, 'Aucune réponse existante à modifier');
  }

  rating.response.content = trimmed;
  await rating.save();

  return rating;
}

export async function deleteUserRatingResponse(userId: string, ratingId: string) {
  const rating = await loadRatingForRecipient(
    userId,
    ratingId,
    'Seul le destinataire de l\'évaluation peut supprimer sa réponse'
  );

  if (!rating.response || !rating.response.content) {
    throw new HttpError(400, 'Aucune réponse à supprimer');
  }

  rating.response = undefined;
  await rating.save();
}
