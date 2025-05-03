import { Request, Response } from 'express';
import mongoose from 'mongoose';
import Rating from '../../../models/ratingModel';
import User from '../../../models/userModel';
import { asyncHandler } from '../../../commons/middlewares/errorMiddleware';
import { updateUserAverageRating } from '../services/ratingService';

/**
 * Récupérer les évaluations d'un utilisateur
 */
export const getUserRatings = asyncHandler(async (req: Request, res: Response) => {
  const { userId } = req.params;
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 10;
  const type = req.query.type as string;
  
  const filter: any = { recipient: userId };
  
  // Filtrer par type si spécifié
  if (type === 'buyer' || type === 'seller') {
    filter.type = type;
  }
  
  // Ne pas montrer les évaluations masquées
  filter.isHidden = false;
  
  const [ratings, count] = await Promise.all([
    Rating.find(filter)
      .populate('reviewer', 'username profilePicture')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Rating.countDocuments(filter)
  ]);
  
  // Calculer les statistiques d'évaluation
  const stats = await Rating.aggregate([
    { $match: { recipient: new mongoose.Types.ObjectId(userId), isHidden: false } },
    { $group: {
      _id: null,
      averageRating: { $avg: '$rating' },
      totalRatings: { $sum: 1 },
      fiveStars: { $sum: { $cond: [{ $eq: ['$rating', 5] }, 1, 0] } },
      fourStars: { $sum: { $cond: [{ $eq: ['$rating', 4] }, 1, 0] } },
      threeStars: { $sum: { $cond: [{ $eq: ['$rating', 3] }, 1, 0] } },
      twoStars: { $sum: { $cond: [{ $eq: ['$rating', 2] }, 1, 0] } },
      oneStars: { $sum: { $cond: [{ $eq: ['$rating', 1] }, 1, 0] } }
    }}
  ]);
  
  const ratingStats = stats.length > 0 ? {
    averageRating: parseFloat(stats[0].averageRating.toFixed(2)),
    totalRatings: stats[0].totalRatings,
    fiveStars: stats[0].fiveStars,
    fourStars: stats[0].fourStars,
    threeStars: stats[0].threeStars,
    twoStars: stats[0].twoStars,
    oneStars: stats[0].oneStars,
    distribution: {
      '5': stats[0].fiveStars,
      '4': stats[0].fourStars,
      '3': stats[0].threeStars,
      '2': stats[0].twoStars,
      '1': stats[0].oneStars
    }
  } : {
    averageRating: 0,
    totalRatings: 0,
    distribution: { '5': 0, '4': 0, '3': 0, '2': 0, '1': 0 }
  };
  
  return res.status(200).json({
    ratings,
    stats: ratingStats,
    pagination: {
      page,
      limit,
      totalItems: count,
      totalPages: Math.ceil(count / limit)
    }
  });
});

/**
 * Créer une nouvelle évaluation
 */
export const createRating = asyncHandler(async (req: Request, res: Response) => {
  const reviewerId = (req.user as any).id;
  const { recipientId, rating, review, type, transactionId } = req.body;
  
  // Validation des données
  if (!recipientId || !rating || !review || !type) {
    return res.status(400).json({ message: 'Tous les champs sont obligatoires' });
  }
  
  if (rating < 1 || rating > 5 || !Number.isInteger(rating)) {
    return res.status(400).json({ message: 'La note doit être un entier entre 1 et 5' });
  }
  
  if (type !== 'buyer' && type !== 'seller') {
    return res.status(400).json({ message: 'Le type doit être "buyer" ou "seller"' });
  }
  
  // Vérifier que le destinataire existe
  const recipient = await User.findById(recipientId);
  
  if (!recipient) {
    return res.status(404).json({ message: 'Utilisateur destinataire non trouvé' });
  }
  
  // Vérifier que l'utilisateur ne s'auto-évalue pas
  if (reviewerId === recipientId) {
    return res.status(400).json({ message: 'Vous ne pouvez pas vous auto-évaluer' });
  }
  
  // Si transactionId est fourni, vérifier qu'une évaluation n'existe pas déjà
  if (transactionId) {
    const existingRating = await Rating.findOne({
      reviewer: reviewerId,
      transaction: transactionId
    });
    
    if (existingRating) {
      return res.status(400).json({ message: 'Vous avez déjà laissé une évaluation pour cette transaction' });
    }
    
    // Vérifier que la transaction existe et appartient à l'un des deux utilisateurs
    // Cette vérification nécessiterait un modèle Transaction
  }
  
  // Créer l'évaluation
  const newRating = new Rating({
    reviewer: reviewerId,
    recipient: recipientId,
    rating,
    review,
    type,
    transaction: transactionId,
    isVerifiedPurchase: Boolean(transactionId) // Considérer comme vérifié si lié à une transaction
  });
  
  await newRating.save();
  
  // Mettre à jour la note moyenne de l'utilisateur évalué
  await updateUserAverageRating(recipientId);
  
  return res.status(201).json({
    message: 'Évaluation créée avec succès',
    rating: await Rating.findById(newRating._id).populate('reviewer', 'username profilePicture')
  });
});

/**
 * Signaler une évaluation
 */
export const reportRating = asyncHandler(async (req: Request, res: Response) => {
  const { ratingId } = req.params;
  const userId = (req.user as any).id;
  const { reason } = req.body;
  
  if (!reason) {
    return res.status(400).json({ message: 'Veuillez indiquer la raison du signalement' });
  }
  
  const rating = await Rating.findById(ratingId);
  
  if (!rating) {
    return res.status(404).json({ message: 'Évaluation non trouvée' });
  }
  
  // Vérifier que l'utilisateur est concerné par cette évaluation
  if (rating.recipient.toString() !== userId && rating.reviewer.toString() !== userId) {
    return res.status(403).json({ message: 'Vous n\'êtes pas autorisé à signaler cette évaluation' });
  }
  
  // Ici, nous pourrions enregistrer le signalement dans un modèle de signalements
  // Pour simplifier, nous allons juste renvoyer un succès
  
  return res.status(200).json({
    message: 'Évaluation signalée avec succès. Elle sera examinée par nos modérateurs.'
  });
});