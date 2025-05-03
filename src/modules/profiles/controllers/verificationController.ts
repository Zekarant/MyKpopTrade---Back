import { Request, Response } from 'express';
import TransactionProof from '../../../models/transactionProofModel';
import User from '../../../models/userModel';
import { asyncHandler } from '../../../commons/middlewares/errorMiddleware';

/**
 * Récupérer les preuves de transaction d'un utilisateur
 */
export const getUserProofs = asyncHandler(async (req: Request, res: Response) => {
  const { userId } = req.params;
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 10;
  
  const filter = { 
    user: userId,
    status: req.query.includeAll ? { $in: ['pending', 'verified', 'rejected'] } : 'verified'
  };
  
  const [proofs, count] = await Promise.all([
    TransactionProof.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    TransactionProof.countDocuments(filter)
  ]);
  
  return res.status(200).json({
    proofs,
    pagination: {
      page,
      limit,
      totalItems: count,
      totalPages: Math.ceil(count / limit)
    }
  });
});

/**
 * Ajouter une preuve de transaction
 */
export const addTransactionProof = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const { type, images, description, otherParty } = req.body;
  
  // Validation des données
  if (!type || !images || !description) {
    return res.status(400).json({ message: 'Type, images et description sont obligatoires' });
  }
  
  if (!Array.isArray(images) || images.length === 0 || images.length > 5) {
    return res.status(400).json({ message: 'Entre 1 et 5 images sont requises' });
  }
  
  if (!['sale', 'purchase', 'exchange'].includes(type)) {
    return res.status(400).json({ message: 'Le type doit être "sale", "purchase" ou "exchange"' });
  }
  
  // Créer la preuve de transaction
  const newProof = new TransactionProof({
    user: userId,
    type,
    images,
    description,
    otherParty
  });
  
  await newProof.save();
  
  return res.status(201).json({
    message: 'Preuve de transaction soumise avec succès. Elle est en cours de vérification.',
    proof: newProof
  });
});

/**
 * Obtenir les statistiques de vérification
 */
export const getUserVerificationStats = asyncHandler(async (req: Request, res: Response) => {
  const { userId } = req.params;
  
  // Vérifier que l'utilisateur existe
  const user = await User.findById(userId, {
    username: 1,
    statistics: 1
  });
  
  if (!user) {
    return res.status(404).json({ message: 'Utilisateur non trouvé' });
  }
  
  // Récupérer les statistiques de preuves
  const stats = await TransactionProof.aggregate([
    { $match: { user: user._id } },
    { $group: {
      _id: '$status',
      count: { $sum: 1 }
    }},
    { $project: {
      status: '$_id',
      count: 1,
      _id: 0
    }}
  ]);
  
  // Formater les résultats
  const formattedStats = {
    verified: 0,
    pending: 0,
    rejected: 0,
    total: 0
  };
  
  stats.forEach(stat => {
    if (stat.status && formattedStats.hasOwnProperty(stat.status)) {
      formattedStats[stat.status as keyof typeof formattedStats] = stat.count;
      formattedStats.total += stat.count;
    }
  });
  
  return res.status(200).json({
    username: user.username,
    statistics: {
      ...formattedStats,
      totalSales: user.statistics?.totalSales || 0,
      totalPurchases: user.statistics?.totalPurchases || 0
    }
  });
});
