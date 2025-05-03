import mongoose from 'mongoose';
import Rating from '../../../models/ratingModel';
import User from '../../../models/userModel';

/**
 * Met à jour la note moyenne d'un utilisateur
 * @param userId ID de l'utilisateur
 */
export const updateUserAverageRating = async (userId: string): Promise<void> => {
  // Calculer la note moyenne de l'utilisateur
  const result = await Rating.aggregate([
    { $match: { recipient: new mongoose.Types.ObjectId(userId), isHidden: false } },
    { $group: {
      _id: null,
      averageRating: { $avg: '$rating' },
      totalCount: { $sum: 1 }
    }}
  ]);
  
  // Si aucune évaluation, mettre à 0
  const averageRating = result.length > 0 ? parseFloat(result[0].averageRating.toFixed(2)) : 0;
  const totalRatings = result.length > 0 ? result[0].totalCount : 0;
  
  // Mettre à jour les statistiques de l'utilisateur
  await User.findByIdAndUpdate(userId, {
    $set: {
      'statistics.averageRating': averageRating,
      'statistics.totalRatings': totalRatings
    }
  });
};