import { Request, Response } from 'express';
import mongoose from 'mongoose';
import User from '../../../models/userModel';
import Product from '../../../models/productModel';
import AuditLog from '../../../models/auditLogModel';
import Report from '../../../models/reportModel';
import Dispute from '../../../models/disputeModel';
import IdentityVerification from '../../../models/identityVerificationModel';
import Payment from '../../../models/paymentModel';
import Post from '../../posts/model';
import { asyncHandler } from '../../../commons/middlewares/errorMiddleware';
import { recordAuditLog } from '../../../commons/utils/auditService';
import { mapHttpError } from '../../../commons/utils/httpErrorMapper';
import { CSV_EXPORT_ROW_LIMIT, sendCsvDownload, wantsCsv } from '../../../commons/utils/csv';
import { dispatchAdminAlert } from '../../../commons/services/adminAlertService';
import { reactivateUser, suspendUser } from '../services/userSanctionService';

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

  const listFields =
    'username email profilePicture role accountStatus suspension sanctions isEmailVerified isIdentityVerified createdAt lastLogin';

  if (wantsCsv(req.query.format)) {
    const rows = await User.find(filter)
      .select(listFields)
      .sort({ createdAt: -1 })
      .limit(CSV_EXPORT_ROW_LIMIT);

    return sendCsvDownload(res, 'utilisateurs', rows, [
      { header: 'Pseudo', value: (u: any) => u.username },
      { header: 'Email', value: (u: any) => u.email },
      { header: 'Rôle', value: (u: any) => u.role },
      { header: 'Statut', value: (u: any) => u.accountStatus },
      { header: 'Motif suspension', value: (u: any) => u.suspension?.reason },
      { header: 'Suspension jusqu\'au', value: (u: any) => u.suspension?.until },
      { header: 'Email vérifié', value: (u: any) => (u.isEmailVerified ? 'oui' : 'non') },
      { header: 'Identité vérifiée', value: (u: any) => (u.isIdentityVerified ? 'oui' : 'non') },
      { header: 'Inscrit le', value: (u: any) => u.createdAt },
      { header: 'Dernière connexion', value: (u: any) => u.lastLogin }
    ]);
  }

  const [users, count] = await Promise.all([
    User.find(filter)
      .select(listFields)
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

const ADMIN_NOTE_MAX_LENGTH = 2000;

export const getUserDetail = asyncHandler(async (req: Request, res: Response) => {
  const { userId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(userId as string)) {
    return res.status(400).json({ message: 'ID d\'utilisateur invalide' });
  }

  const user = await User.findById(userId)
    .select(
      'username email profilePicture role accountStatus suspension sanctions adminNotes ' +
        'bio location isEmailVerified isIdentityVerified createdAt lastLogin statistics'
    )
    .populate('adminNotes.author', 'username')
    .populate('sanctions.by', 'username');

  if (!user) {
    return res.status(404).json({ message: 'Utilisateur non trouvé' });
  }

  const [listings, reportsAgainst, reportsFiled, disputes] = await Promise.all([
    Product.countDocuments({ seller: userId }),
    Report.countDocuments({ targetType: 'user', targetId: userId }),
    Report.countDocuments({ reporter: userId }),
    Dispute.countDocuments({ $or: [{ buyer: userId }, { seller: userId }] })
  ]);

  return res.status(200).json({
    user,
    activity: { listings, reportsAgainst, reportsFiled, disputes }
  });
});

export const addUserNote = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.params.userId as string;
  const { content } = req.body;
  const adminId = (req as any).user.id;

  if (typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ message: 'Le contenu de la note est obligatoire' });
  }

  const note = {
    content: content.trim().slice(0, ADMIN_NOTE_MAX_LENGTH),
    author: adminId,
    createdAt: new Date()
  };

  const user = await User.findByIdAndUpdate(
    userId,
    { $push: { adminNotes: note } },
    { new: true, runValidators: false }
  )
    .select('adminNotes username')
    .populate('adminNotes.author', 'username');

  if (!user) {
    return res.status(404).json({ message: 'Utilisateur non trouvé' });
  }

  await recordAuditLog({
    adminId,
    action: 'add_user_note',
    targetType: 'user',
    targetId: userId,
    details: `Note interne ajoutée sur ${user.username}`
  });

  return res.status(201).json({ message: 'Note ajoutée', adminNotes: user.adminNotes });
});

export const deleteUserNote = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.params.userId as string;
  const noteId = req.params.noteId as string;
  const adminId = (req as any).user.id;

  const user = await User.findByIdAndUpdate(
    userId,
    { $pull: { adminNotes: { _id: noteId } } },
    { new: true, runValidators: false }
  )
    .select('adminNotes username')
    .populate('adminNotes.author', 'username');

  if (!user) {
    return res.status(404).json({ message: 'Utilisateur non trouvé' });
  }

  await recordAuditLog({
    adminId,
    action: 'delete_user_note',
    targetType: 'user',
    targetId: userId,
    details: `Note interne supprimée sur ${user.username}`
  });

  return res.status(200).json({ message: 'Note supprimée', adminNotes: user.adminNotes });
});

const GLOBAL_SEARCH_LIMIT = 6;
const GLOBAL_SEARCH_MIN_LENGTH = 2;

export const adminGlobalSearch = asyncHandler(async (req: Request, res: Response) => {
  const term = String(req.query.q ?? '').trim();

  if (term.length < GLOBAL_SEARCH_MIN_LENGTH) {
    return res.status(200).json({ results: [] });
  }

  const pattern = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

  const [users, products, posts] = await Promise.all([
    User.find({ $or: [{ username: pattern }, { email: pattern }] })
      .select('username email accountStatus role')
      .limit(GLOBAL_SEARCH_LIMIT),
    Product.find({ title: pattern })
      .select('title price currency isSold')
      .limit(GLOBAL_SEARCH_LIMIT),
    Post.find({ content: pattern })
      .select('content isReply author')
      .populate('author', 'username')
      .limit(GLOBAL_SEARCH_LIMIT)
  ]);

  const results = [
    ...users.map((user: any) => ({
      kind: 'user',
      id: String(user._id),
      label: user.username,
      detail: `${user.email} · ${user.accountStatus}`,
      tab: 'users',
      search: user.username
    })),
    ...products.map((product: any) => ({
      kind: 'product',
      id: String(product._id),
      label: product.title,
      detail: `${product.price} ${product.currency}${product.isSold ? ' · vendu' : ''}`,
      tab: 'products',
      search: product.title
    })),
    ...posts.map((post: any) => ({
      kind: 'post',
      id: String(post._id),
      label: post.content.slice(0, 80),
      detail: `${post.isReply ? 'Réponse' : 'Publication'} de ${post.author?.username || 'inconnu'}`,
      tab: 'moderation',
      search: post.content.slice(0, 40)
    }))
  ];

  return res.status(200).json({ results });
});

const QUEUE_ITEMS_PER_SOURCE = 25;

const DISPUTE_PENDING_STATUSES = ['opened', 'under_review'];

const VERIFICATION_DOCUMENT_LABELS: Record<string, string> = {
  id_card: 'Carte d\'identité',
  passport: 'Passeport',
  driver_license: 'Permis de conduire'
};

const DISPUTE_REASON_LABELS: Record<string, string> = {
  not_received: 'Colis non reçu',
  damaged: 'Colis endommagé',
  not_as_described: 'Non conforme',
  counterfeit: 'Contrefaçon',
  wrong_item: 'Mauvais article',
  partial_delivery: 'Livraison partielle',
  seller_unresponsive: 'Vendeur silencieux',
  buyer_abuse: 'Comportement acheteur',
  other: 'Autre'
};

const QUEUE_REASON_LABELS: Record<string, string> = {
  inappropriate_content: 'Contenu inapproprié',
  offensive_language: 'Langage offensant',
  false_information: 'Fausses informations',
  spam: 'Spam',
  fraud: 'Fraude',
  copyright_violation: 'Violation de droit d\'auteur',
  other: 'Autre'
};

interface QueueItem {
  kind: 'report' | 'dispute' | 'verification' | 'deletion';
  id: string;
  label: string;
  detail: string;
  subject: string;
  waitingSince: Date;
  tab: string;
}

export const getAdminQueue = asyncHandler(async (_req: Request, res: Response) => {
  const [reports, disputes, verifications, deletions] = await Promise.all([
    Report.find({ status: 'pending' })
      .populate('reporter', 'username')
      .select('reason targetType createdAt reporter')
      .sort({ createdAt: 1 })
      .limit(QUEUE_ITEMS_PER_SOURCE),
    Dispute.find({ status: { $in: DISPUTE_PENDING_STATUSES } })
      .populate('buyer', 'username')
      .populate('seller', 'username')
      .select('reason status createdAt buyer seller')
      .sort({ createdAt: 1 })
      .limit(QUEUE_ITEMS_PER_SOURCE),
    IdentityVerification.find({ status: 'pending' })
      .populate('user', 'username')
      .select('documentType submittedAt user')
      .sort({ submittedAt: 1 })
      .limit(QUEUE_ITEMS_PER_SOURCE),
    User.find({ scheduledForDeletion: true })
      .select('username scheduledDeletionDate updatedAt')
      .sort({ scheduledDeletionDate: 1 })
      .limit(QUEUE_ITEMS_PER_SOURCE)
  ]);

  const items: QueueItem[] = [
    ...reports.map((report: any) => ({
      kind: 'report' as const,
      id: String(report._id),
      label: 'Signalement',
      detail: `${QUEUE_REASON_LABELS[report.reason] || report.reason} — ${report.targetType === 'product' ? 'produit' : 'avis'}`,
      subject: report.reporter?.username || 'inconnu',
      waitingSince: report.createdAt,
      tab: 'reports'
    })),
    ...disputes.map((dispute: any) => ({
      kind: 'dispute' as const,
      id: String(dispute._id),
      label: dispute.status === 'under_review' ? 'Litige en arbitrage' : 'Litige ouvert',
      detail: DISPUTE_REASON_LABELS[dispute.reason] || dispute.reason,
      subject: `${dispute.buyer?.username || '?'} → ${dispute.seller?.username || '?'}`,
      waitingSince: dispute.createdAt,
      tab: 'disputes'
    })),
    ...verifications.map((verification: any) => ({
      kind: 'verification' as const,
      id: String(verification._id),
      label: 'Vérification d\'identité',
      detail: VERIFICATION_DOCUMENT_LABELS[verification.documentType] || verification.documentType,
      subject: verification.user?.username || 'inconnu',
      waitingSince: verification.submittedAt,
      tab: 'verifications'
    })),
    ...deletions.map((user: any) => ({
      kind: 'deletion' as const,
      id: String(user._id),
      label: 'Suppression de compte',
      detail: user.scheduledDeletionDate
        ? `Échéance le ${new Date(user.scheduledDeletionDate).toLocaleDateString('fr-FR')}`
        : 'Échéance non planifiée',
      subject: user.username,
      waitingSince: user.updatedAt,
      tab: 'rgpd'
    }))
  ].sort((a, b) => new Date(a.waitingSince).getTime() - new Date(b.waitingSince).getTime());

  const [reportsTotal, disputesTotal, verificationsTotal, deletionsTotal] = await Promise.all([
    Report.countDocuments({ status: 'pending' }),
    Dispute.countDocuments({ status: { $in: DISPUTE_PENDING_STATUSES } }),
    IdentityVerification.countDocuments({ status: 'pending' }),
    User.countDocuments({ scheduledForDeletion: true })
  ]);

  const oldest = items[0]?.waitingSince;

  return res.status(200).json({
    items,
    counts: {
      report: reportsTotal,
      dispute: disputesTotal,
      verification: verificationsTotal,
      deletion: deletionsTotal
    },
    total: reportsTotal + disputesTotal + verificationsTotal + deletionsTotal,
    oldestWaitingSince: oldest ?? null
  });
});

const TIMESERIES_DAYS = 30;

const toDayKey = (date: Date): string => date.toISOString().slice(0, 10);

const indexDailyBuckets = (buckets: any[], field = 'count'): Record<string, number> =>
  buckets.reduce((acc: Record<string, number>, bucket: any) => {
    acc[bucket._id] = bucket[field] ?? 0;
    return acc;
  }, {});

const dailyCountPipeline = (dateField: string, since: Date, match: Record<string, any> = {}) => [
  { $match: { ...match, [dateField]: { $gte: since } } },
  {
    $group: {
      _id: { $dateToString: { format: '%Y-%m-%d', date: `$${dateField}` } },
      count: { $sum: 1 },
      amount: { $sum: '$amount' }
    }
  }
];

export const getStatsTimeseries = asyncHandler(async (_req: Request, res: Response) => {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  since.setUTCDate(since.getUTCDate() - (TIMESERIES_DAYS - 1));

  const [signups, listings, sales, reports] = await Promise.all([
    User.aggregate(dailyCountPipeline('createdAt', since)),
    Product.aggregate(dailyCountPipeline('createdAt', since)),
    Payment.aggregate(dailyCountPipeline('completedAt', since, { status: 'completed' })),
    Report.aggregate(dailyCountPipeline('createdAt', since))
  ]);

  const signupsByDay = indexDailyBuckets(signups);
  const listingsByDay = indexDailyBuckets(listings);
  const salesByDay = indexDailyBuckets(sales);
  const revenueByDay = indexDailyBuckets(sales, 'amount');
  const reportsByDay = indexDailyBuckets(reports);

  const series = Array.from({ length: TIMESERIES_DAYS }, (_, offset) => {
    const day = new Date(since);
    day.setUTCDate(day.getUTCDate() + offset);
    const key = toDayKey(day);

    return {
      date: key,
      signups: signupsByDay[key] ?? 0,
      listings: listingsByDay[key] ?? 0,
      sales: salesByDay[key] ?? 0,
      revenue: Number((revenueByDay[key] ?? 0).toFixed(2)),
      reports: reportsByDay[key] ?? 0
    };
  });

  return res.status(200).json({ days: TIMESERIES_DAYS, series });
});

/**
 * Modifier le statut d'un utilisateur (suspendre/réactiver)
 */
export const updateUserStatus = asyncHandler(async (req: Request, res: Response) => {
  const { userId } = req.params;
  const { accountStatus, reason, durationDays } = req.body;
  const adminId = (req as any).user.id;

  if (!accountStatus || !['active', 'suspended'].includes(accountStatus)) {
    return res.status(400).json({ message: 'Statut invalide. Doit être "active" ou "suspended"' });
  }

  try {
    const user =
      accountStatus === 'suspended'
        ? await suspendUser({ adminId, userId: userId as string, reason, durationDays })
        : await reactivateUser({ adminId, userId: userId as string, reason });

    return res.status(200).json({
      message: `Utilisateur ${accountStatus === 'suspended' ? 'suspendu' : 'réactivé'} avec succès`,
      user: {
        id: user._id,
        username: user.username,
        accountStatus: user.accountStatus,
        suspension: user.suspension
      }
    });
  } catch (error) {
    const mapped = mapHttpError(res, error);
    if (mapped) return mapped;
    throw error;
  }
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

  dispatchAdminAlert({
    event: 'user.role_changed',
    severity: role === 'user' ? 'info' : 'warning',
    title: `Rôle modifié : ${user.username}`,
    summary: `${oldRole} → ${role}`,
    adminTab: 'users',
    fields: [
      { name: 'Ancien rôle', value: oldRole, inline: true },
      { name: 'Nouveau rôle', value: role, inline: true }
    ],
    data: { userId, oldRole, newRole: role }
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
  }).select('-password -emailVerificationToken -passwordResetToken -phoneVerificationCode -adminNotes');

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

  dispatchAdminAlert({
    event: 'gdpr.user_anonymized',
    severity: 'info',
    title: 'Utilisateur anonymisé',
    summary: `Anonymisation effectuée par un administrateur (RGPD Art. 17).`,
    adminTab: 'rgpd',
    fields: [{ name: 'Identifiant anonymisé', value: anonymizedId, inline: true }],
    data: { anonymizedId }
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

  dispatchAdminAlert({
    event: 'gdpr.deletion_confirmed',
    severity: 'info',
    title: 'Suppression de compte confirmée',
    summary: 'Un administrateur a exécuté une demande de suppression de compte.',
    adminTab: 'rgpd',
    fields: [{ name: 'Identifiant anonymisé', value: anonymizedId, inline: true }],
    data: { anonymizedId }
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
