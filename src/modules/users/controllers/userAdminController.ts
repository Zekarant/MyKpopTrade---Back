import { Request, Response } from 'express';
import User from '../../../models/userModel';
import Product from '../../../models/productModel';
import AuditLog from '../../../models/auditLogModel';
import { asyncHandler } from '../../../commons/middlewares/errorMiddleware';

/**
 * Liste tous les utilisateurs avec pagination et filtrage (admin)
 */
export const getUsers = asyncHandler(async (req: Request, res: Response) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;
  const search = req.query.search as string;
  const role = req.query.role as string;
  const status = req.query.status as string;

  const filter: any = {};

  if (search) {
    filter.$or = [
      { username: { $regex: search, $options: 'i' } },
      { email: { $regex: search, $options: 'i' } }
    ];
  }

  if (role && ['user', 'moderator', 'admin'].includes(role)) {
    filter.role = role;
  }

  if (status && ['active', 'suspended', 'deleted'].includes(status)) {
    filter.accountStatus = status;
  }

  const [users, count] = await Promise.all([
    User.find(filter)
      .select('username email profilePicture role accountStatus isEmailVerified isIdentityVerified createdAt lastLogin')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    User.countDocuments(filter)
  ]);

  return res.status(200).json({
    users,
    pagination: {
      page,
      limit,
      totalItems: count,
      totalPages: Math.ceil(count / limit)
    }
  });
});

/**
 * Obtenir les statistiques admin
 */
export const getAdminStats = asyncHandler(async (req: Request, res: Response) => {
  const [totalUsers, activeUsers, suspendedUsers] = await Promise.all([
    User.countDocuments({}),
    User.countDocuments({ accountStatus: 'active' }),
    User.countDocuments({ accountStatus: 'suspended' })
  ]);

  // Utilisateurs créés dans les 30 derniers jours
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const newUsers = await User.countDocuments({ createdAt: { $gte: thirtyDaysAgo } });

  return res.status(200).json({
    totalUsers,
    activeUsers,
    suspendedUsers,
    newUsers
  });
});

/**
 * Modifier le statut d'un utilisateur (suspendre/réactiver)
 */
export const updateUserStatus = asyncHandler(async (req: Request, res: Response) => {
  const { userId } = req.params;
  const { accountStatus } = req.body;

  if (!accountStatus || !['active', 'suspended'].includes(accountStatus)) {
    return res.status(400).json({ message: 'Statut invalide. Doit être "active" ou "suspended"' });
  }

  const user = await User.findById(userId);
  if (!user) {
    return res.status(404).json({ message: 'Utilisateur non trouvé' });
  }

  if (user.role === 'admin') {
    return res.status(403).json({ message: 'Impossible de modifier le statut d\'un administrateur' });
  }

  user.accountStatus = accountStatus;
  await user.save({ validateBeforeSave: false });

  await AuditLog.create({
    admin: (req as any).user.id,
    action: accountStatus === 'suspended' ? 'suspend_user' : 'reactivate_user',
    targetType: 'user',
    targetId: userId,
    details: `Utilisateur ${user.username} ${accountStatus === 'suspended' ? 'suspendu' : 'réactivé'}`
  });

  return res.status(200).json({
    message: `Utilisateur ${accountStatus === 'suspended' ? 'suspendu' : 'réactivé'} avec succès`,
    user: {
      id: user._id,
      username: user.username,
      accountStatus: user.accountStatus
    }
  });
});

/**
 * Modifier le rôle d'un utilisateur
 */
export const updateUserRole = asyncHandler(async (req: Request, res: Response) => {
  const { userId } = req.params;
  const { role } = req.body;

  if (!role || !['user', 'moderator', 'admin'].includes(role)) {
    return res.status(400).json({ message: 'Rôle invalide' });
  }

  const user = await User.findById(userId);
  if (!user) {
    return res.status(404).json({ message: 'Utilisateur non trouvé' });
  }

  const oldRole = user.role;
  user.role = role;
  await user.save({ validateBeforeSave: false });

  await AuditLog.create({
    admin: (req as any).user.id,
    action: 'change_role',
    targetType: 'user',
    targetId: userId,
    details: `Rôle de ${user.username} changé: ${oldRole} → ${role}`
  });

  return res.status(200).json({
    message: `Rôle modifié en "${role}" avec succès`,
    user: {
      id: user._id,
      username: user.username,
      role: user.role
    }
  });
});

/**
 * RGPD: Obtenir les demandes de suppression en attente
 */
export const getDeletionRequests = asyncHandler(async (req: Request, res: Response) => {
  const users = await User.find({ scheduledForDeletion: true })
    .select('username email scheduledDeletionDate createdAt')
    .sort({ scheduledDeletionDate: 1 });

  return res.status(200).json({ users });
});

/**
 * RGPD: Statistiques de consentement
 */
export const getRgpdStats = asyncHandler(async (req: Request, res: Response) => {
  const [privacyAccepted, dataProcessing, marketing] = await Promise.all([
    User.countDocuments({ privacyPolicyAccepted: true }),
    User.countDocuments({ dataProcessingConsent: true }),
    User.countDocuments({ marketingConsent: true })
  ]);

  return res.status(200).json({ privacyAccepted, dataProcessing, marketing });
});

/**
 * RGPD: Export des données d'un utilisateur (Art. 15 - Droit d'accès)
 */
export const adminExportUserData = asyncHandler(async (req: Request, res: Response) => {
  const search = req.query.search as string;
  if (!search) {
    return res.status(400).json({ message: 'Paramètre de recherche requis' });
  }

  const user = await User.findOne({
    $or: [
      { username: { $regex: `^${search}$`, $options: 'i' } },
      { email: { $regex: `^${search}$`, $options: 'i' } }
    ]
  }).select('-password -emailVerificationToken -passwordResetToken -phoneVerificationCode -paypalTokens');

  if (!user) {
    return res.status(404).json({ message: 'Utilisateur introuvable' });
  }

  const products = await Product.find({ seller: user._id }).select('-__v');

  return res.status(200).json({
    exportDate: new Date().toISOString(),
    user: user.toObject(),
    products,
  });
});

/**
 * RGPD: Anonymiser un utilisateur (Art. 17 - Droit à l'effacement)
 */
export const adminAnonymizeUser = asyncHandler(async (req: Request, res: Response) => {
  const { search } = req.body;
  if (!search) {
    return res.status(400).json({ message: 'Paramètre de recherche requis' });
  }

  const user = await User.findOne({
    $or: [
      { username: { $regex: `^${search}$`, $options: 'i' } },
      { email: { $regex: `^${search}$`, $options: 'i' } }
    ]
  });

  if (!user) {
    return res.status(404).json({ message: 'Utilisateur introuvable' });
  }

  if (user.role === 'admin') {
    return res.status(403).json({ message: 'Impossible d\'anonymiser un administrateur' });
  }

  const anonymizedId = `anon_${user._id.toString().slice(-8)}`;
  user.username = anonymizedId;
  user.email = `${anonymizedId}@anonymized.local`;
  user.profilePicture = '';
  user.profileBanner = '';
  user.bio = '';
  user.location = '';
  user.socialLinks = { instagram: '', twitter: '', discord: '' };
  user.anonymized = true;
  user.accountStatus = 'deleted';
  user.isActive = false;

  await user.save({ validateBeforeSave: false });

  await AuditLog.create({
    admin: (req as any).user.id,
    action: 'anonymize_user',
    targetType: 'user',
    targetId: user._id,
    details: `Utilisateur anonymisé (RGPD Art. 17)`,
    metadata: { anonymizedId }
  });

  return res.status(200).json({ message: 'Utilisateur anonymisé avec succès' });
});

/**
 * RGPD: Confirmer la suppression d'un compte
 */
export const confirmDeletion = asyncHandler(async (req: Request, res: Response) => {
  const { userId } = req.params;

  const user = await User.findById(userId);
  if (!user) {
    return res.status(404).json({ message: 'Utilisateur non trouvé' });
  }

  const anonymizedId = `deleted_${user._id.toString().slice(-8)}`;
  user.username = anonymizedId;
  user.email = `${anonymizedId}@deleted.local`;
  user.profilePicture = '';
  user.profileBanner = '';
  user.bio = '';
  user.location = '';
  user.socialLinks = { instagram: '', twitter: '', discord: '' };
  user.anonymized = true;
  user.accountStatus = 'deleted';
  user.isActive = false;
  user.scheduledForDeletion = false;

  await user.save({ validateBeforeSave: false });

  await AuditLog.create({
    admin: (req as any).user.id,
    action: 'confirm_deletion',
    targetType: 'user',
    targetId: user._id,
    details: 'Suppression de compte confirmée et anonymisée'
  });

  return res.status(200).json({ message: 'Compte supprimé et anonymisé' });
});

/**
 * RGPD: Annuler une demande de suppression
 */
export const adminCancelDeletion = asyncHandler(async (req: Request, res: Response) => {
  const { userId } = req.params;

  const user = await User.findById(userId);
  if (!user) {
    return res.status(404).json({ message: 'Utilisateur non trouvé' });
  }

  user.scheduledForDeletion = false;
  user.scheduledDeletionDate = undefined;
  await user.save({ validateBeforeSave: false });

  await AuditLog.create({
    admin: (req as any).user.id,
    action: 'cancel_deletion',
    targetType: 'user',
    targetId: user._id,
    details: 'Demande de suppression annulée'
  });

  return res.status(200).json({ message: 'Demande de suppression annulée' });
});
