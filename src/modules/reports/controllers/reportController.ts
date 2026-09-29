import { Request, Response } from 'express';
import mongoose from 'mongoose';
import Report, {
  type IReport,
  REPORT_REASONS,
  REPORT_TARGET_TYPES,
  REPORT_TEXT_MAX_LENGTH,
  type ReportTargetType
} from '../../../models/reportModel';
import Rating from '../../../models/ratingModel';
import Product from '../../../models/productModel';
import Post from '../../posts/model';
import User, { type IUser } from '../../../models/userModel';
import { asyncHandler } from '../../../commons/middlewares/errorMiddleware';
import logger from '../../../commons/utils/logger';
import { recordAuditLog } from '../../../commons/utils/auditService';
import { dispatchAdminAlert } from '../../../commons/services/adminAlertService';
import { CSV_EXPORT_ROW_LIMIT, sendCsvDownload, wantsCsv } from '../../../commons/utils/csv';
import { clampLimit } from '../../../commons/utils/pagination';
import { queryInt, queryString } from '../../../commons/utils/query';

/** Code MongoDB d'une violation d'index unique. */
const DUPLICATE_KEY_ERROR = 11000;

function pagination(req: Request, defaultLimit: number, maxLimit: number) {
  return {
    page: Math.max(1, queryInt(req.query.page) || 1),
    limit: clampLimit(req.query.limit, defaultLimit, maxLimit)
  };
}

const isReason = (value: unknown): value is (typeof REPORT_REASONS)[number] =>
  typeof value === 'string' && (REPORT_REASONS as readonly string[]).includes(value);

const REASON_LABELS: Record<string, string> = {
  inappropriate_content: 'Contenu inapproprié',
  offensive_language: 'Langage offensant',
  false_information: 'Fausses informations',
  spam: 'Spam',
  fraud: 'Fraude',
  copyright_violation: 'Violation de droit d\'auteur',
  other: 'Autre'
};

const TARGET_TYPE_LABELS: Record<string, string> = {
  product: 'Produit',
  rating: 'Avis',
  user: 'Profil',
  post: 'Publication'
};

const EXCERPT_LENGTH = 400;

const excerpt = (value?: string): string =>
  !value ? '' : value.length <= EXCERPT_LENGTH ? value : `${value.slice(0, EXCERPT_LENGTH)}…`;

const isValidTargetType = (value: unknown): value is ReportTargetType =>
  typeof value === 'string' && REPORT_TARGET_TYPES.includes(value as ReportTargetType);

const findTarget = async (targetType: ReportTargetType, targetId: string) => {
  if (targetType === 'rating') return Rating.findById(targetId);
  if (targetType === 'product') return Product.findById(targetId);
  if (targetType === 'post') return Post.findById(targetId);
  return User.findById(targetId);
};

type ReportTargetSummary = {
  _id?: unknown;
  title?: string;
  rating?: number;
  review?: string;
  content?: string;
  username?: string;
};

const describeTarget = (targetType: string, target: ReportTargetSummary | null): string => {
  if (targetType === 'product') return target?.title || 'produit inconnu';
  if (targetType === 'rating') return `${target?.rating ?? '?'}/5 — ${excerpt(target?.review) || 'sans commentaire'}`;
  if (targetType === 'post') return excerpt(target?.content) || 'publication vide';
  if (targetType === 'user') return target?.username || 'profil inconnu';
  return String(target?._id ?? 'cible inconnue');
};

/**
 * Créer un nouveau signalement
 */
export const createReport = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { targetType, targetId, reason, details } = req.body;
  
  // Validation des données
  if (!targetType || !targetId || !reason) {
    return res.status(400).json({ 
      message: 'Le type de cible, l\'ID de la cible et la raison sont obligatoires' 
    });
  }
  
  if (!isValidTargetType(targetType)) {
    return res.status(400).json({
      message: `Type de cible invalide. Valeurs acceptées : ${REPORT_TARGET_TYPES.join(', ')}`
    });
  }

  if (typeof targetId !== 'string' || !mongoose.Types.ObjectId.isValid(targetId)) {
    return res.status(400).json({ message: 'ID de cible invalide' });
  }

  // Validés ici plutôt que par le schéma : une ValidationError répondrait 500.
  if (!isReason(reason)) {
    return res.status(400).json({ message: `Motif invalide. Valeurs acceptées : ${REPORT_REASONS.join(', ')}` });
  }
  if (details !== undefined && details !== null && (typeof details !== 'string' || details.length > REPORT_TEXT_MAX_LENGTH)) {
    return res.status(400).json({ message: `Les détails sont limités à ${REPORT_TEXT_MAX_LENGTH} caractères` });
  }

  if (targetType === 'user' && String(targetId) === String(userId)) {
    return res.status(400).json({ message: 'Vous ne pouvez pas signaler votre propre profil' });
  }

  let target = null;

  try {
    target = await findTarget(targetType, targetId);
  } catch (error) {
    logger.error('Erreur lors de la vérification de l\'existence de la cible:', error);
    return res.status(500).json({ message: 'Erreur lors de la vérification de la cible' });
  }

  if (!target) {
    return res.status(404).json({ message: 'Cible du signalement non trouvée' });
  }

  // Vérifier si l'utilisateur a déjà signalé cette cible
  const existingReport = await Report.findOne({
    reporter: userId,
    targetType,
    targetId
  });
  
  if (existingReport) {
    return res.status(400).json({ 
      message: 'Vous avez déjà signalé cet élément',
      reportId: existingReport._id
    });
  }
  
  // Créer le signalement
  const report = new Report({
    reporter: userId,
    targetType,
    targetId,
    reason,
    details: details || '',
    status: 'pending'
  });

  try {
    await report.save();
  } catch (error) {
    // Double envoi simultané : l'index unique a refusé le second.
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === DUPLICATE_KEY_ERROR) {
      return res.status(400).json({ message: 'Vous avez déjà signalé cet élément' });
    }
    throw error;
  }
  
  logger.info('Nouveau signalement créé', {
    reportId: report._id,
    targetType,
    targetId,
    userId
  });

  const reporter = await User.findById(userId).select('username');
  const reasonLabel = REASON_LABELS[report.reason] || report.reason;

  dispatchAdminAlert({
    event: 'report.created',
    severity: 'warning',
    title: `Nouveau signalement : ${reasonLabel}`,
    summary: `${TARGET_TYPE_LABELS[targetType] || targetType} signalé par ${reporter?.username || 'un utilisateur'}.`,
    adminTab: 'reports',
    fields: [
      { name: 'Signaleur', value: reporter?.username || 'inconnu', inline: true },
      { name: 'Type de cible', value: TARGET_TYPE_LABELS[targetType] || targetType, inline: true },
      { name: 'Cible', value: describeTarget(targetType, target) },
      ...(details ? [{ name: 'Détails', value: excerpt(String(details)) }] : [])
    ],
    data: { reportId: report._id, targetType, targetId }
  });

  return res.status(201).json({
    message: 'Signalement créé avec succès',
    report: {
      id: report._id,
      reason: report.reason,
      status: report.status,
      createdAt: report.createdAt
    }
  });
});

/**
 * Récupérer ses propres signalements
 */
export const getUserReports = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { page, limit } = pagination(req, 10, 50);
  const status = queryString(req.query.status);
  
  // Construire le filtre
  const filter: mongoose.QueryFilter<IReport> = { reporter: userId };
  
  if (status && ['pending', 'reviewed', 'resolved', 'rejected'].includes(status)) {
    filter.status = status as IReport['status'];
  }
  
  const [reports, count] = await Promise.all([
    Report.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Report.countDocuments(filter)
  ]);
  
  return res.status(200).json({
    reports,
    pagination: {
      page,
      limit,
      totalItems: count,
      totalPages: Math.ceil(count / limit)
    }
  });
});

/**
 * Vérifier si l'utilisateur a déjà signalé un élément
 */
export const checkUserReport = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const targetType = req.params.targetType as string;
  const targetId = req.params.targetId as string;
  
  if (!targetType || !targetId) {
    return res.status(400).json({ 
      message: 'Type et ID de la cible sont requis' 
    });
  }
  
  if (!isValidTargetType(targetType)) {
    return res.status(400).json({
      message: `Type de cible invalide. Valeurs acceptées : ${REPORT_TARGET_TYPES.join(', ')}`
    });
  }

  if (!mongoose.Types.ObjectId.isValid(targetId)) {
    return res.status(400).json({ message: 'ID de cible invalide' });
  }

  const existingReport = await Report.findOne({
    reporter: userId,
    targetType,
    targetId
  });
  
  return res.status(200).json({
    hasReported: !!existingReport,
    report: existingReport ? {
      id: existingReport._id,
      status: existingReport.status,
      reason: existingReport.reason,
      createdAt: existingReport.createdAt
    } : null
  });
});

// FONCTIONS ADMIN CI-DESSOUS (à protéger par des middlewares d'administration)

/**
 * Récupérer tous les signalements (admin)
 */
export const getAllReports = asyncHandler(async (req: Request, res: Response) => {
  const { page, limit } = pagination(req, 20, 100);
  const status = queryString(req.query.status);
  const targetType = queryString(req.query.targetType);
  
  // Construire le filtre
  const filter: mongoose.QueryFilter<IReport> = {};
  
  if (status && ['pending', 'reviewed', 'resolved', 'rejected'].includes(status)) {
    filter.status = status as IReport['status'];
  }
  
  if (isValidTargetType(targetType)) {
    filter.targetType = targetType;
  }

  if (wantsCsv(req.query.format)) {
    const rows = await Report.find(filter)
      .populate<{ reporter: Pick<IUser, 'username' | 'email'> | null }>('reporter', 'username email')
      .sort({ createdAt: -1 })
      .limit(CSV_EXPORT_ROW_LIMIT);

    return sendCsvDownload(res, 'signalements', rows, [
      { header: 'Date', value: (r) => r.createdAt },
      { header: 'Signaleur', value: (r) => r.reporter?.username },
      { header: 'Email signaleur', value: (r) => r.reporter?.email },
      { header: 'Type de cible', value: (r) => TARGET_TYPE_LABELS[r.targetType] || r.targetType },
      { header: 'ID cible', value: (r) => r.targetId },
      { header: 'Motif', value: (r) => REASON_LABELS[r.reason] || r.reason },
      { header: 'Détails', value: (r) => r.details },
      { header: 'Statut', value: (r) => r.status },
      { header: 'Notes admin', value: (r) => r.adminNotes },
      { header: 'Résolu le', value: (r) => r.resolvedAt }
    ]);
  }

  const [reports, count] = await Promise.all([
    Report.find(filter)
      .populate('reporter', 'username profilePicture')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Report.countDocuments(filter)
  ]);
  
  return res.status(200).json({
    reports,
    pagination: {
      page,
      limit,
      totalItems: count,
      totalPages: Math.ceil(count / limit)
    }
  });
});

const OWNER_FIELDS = 'username profilePicture accountStatus role isIdentityVerified';

const loadReportTarget = async (targetType: string, targetId: mongoose.Types.ObjectId) => {
  if (targetType === 'user') {
    const user = await User.findById(targetId).select(
      `${OWNER_FIELDS} email bio location createdAt suspension`
    );
    if (!user) return null;

    return {
      type: 'user',
      id: user._id,
      label: user.username,
      excerpt: user.bio || '',
      images: user.profilePicture ? [user.profilePicture] : [],
      owner: user,
      createdAt: user.createdAt,
      meta: { location: user.location, isSuspended: user.accountStatus === 'suspended' }
    };
  }

  if (targetType === 'post') {
    const post = await Post.findById(targetId)
      .select('content images isReply likesCount repliesCount author createdAt')
      .populate('author', OWNER_FIELDS);
    if (!post) return null;

    return {
      type: 'post',
      id: post._id,
      label: post.isReply ? 'Réponse' : 'Publication',
      excerpt: excerpt(post.content),
      images: post.images ?? [],
      owner: post.author,
      createdAt: post.createdAt,
      meta: { isReply: post.isReply, likesCount: post.likesCount, repliesCount: post.repliesCount }
    };
  }

  if (targetType === 'product') {
    const product = await Product.findById(targetId)
      .select('title description price currency images isAvailable isSold isReserved type condition seller createdAt')
      .populate('seller', OWNER_FIELDS);
    if (!product) return null;

    return {
      type: 'product',
      id: product._id,
      label: product.title,
      excerpt: excerpt(product.description),
      images: product.images ?? [],
      owner: product.seller,
      createdAt: product.createdAt,
      meta: {
        price: product.price,
        currency: product.currency,
        condition: product.condition,
        productType: product.type,
        isSold: product.isSold,
        isAvailable: product.isAvailable,
        isReserved: product.isReserved
      }
    };
  }

  const rating = await Rating.findById(targetId)
    .select('rating review images isHidden reviewer recipient createdAt')
    .populate('reviewer', OWNER_FIELDS)
    .populate('recipient', 'username profilePicture');
  if (!rating) return null;

  return {
    type: 'rating',
    id: rating._id,
    label: `Avis ${rating.rating}/5`,
    excerpt: excerpt(rating.review),
    images: rating.images ?? [],
    owner: rating.reviewer,
    createdAt: rating.createdAt,
    meta: {
      rating: rating.rating,
      isHidden: rating.isHidden,
      recipient: rating.recipient
    }
  };
};

export const getReportDetail = asyncHandler(async (req: Request, res: Response) => {
  const { reportId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(reportId as string)) {
    return res.status(400).json({ message: 'ID de signalement invalide' });
  }

  const report = await Report.findById(reportId)
    .populate('reporter', 'username email profilePicture accountStatus role createdAt');

  if (!report) {
    return res.status(404).json({ message: 'Signalement non trouvé' });
  }

  const [target, reporterReports, targetReports] = await Promise.all([
    loadReportTarget(report.targetType, report.targetId),
    Report.find({ reporter: report.reporter }).select('status'),
    Report.countDocuments({ targetType: report.targetType, targetId: report.targetId })
  ]);

  const countByStatus = (status: string) =>
    reporterReports.filter((r) => r.status === status).length;

  return res.status(200).json({
    report,
    reasonLabel: REASON_LABELS[report.reason] || report.reason,
    target,
    reporterHistory: {
      total: reporterReports.length,
      resolved: countByStatus('resolved'),
      rejected: countByStatus('rejected'),
      pending: countByStatus('pending')
    },
    targetHistory: { totalReports: targetReports }
  });
});

const BULK_REPORT_LIMIT = 100;

const RESOLVABLE_STATUSES = ['reviewed', 'resolved', 'rejected'];

export const bulkUpdateReportStatus = asyncHandler(async (req: Request, res: Response) => {
  const { reportIds, status, adminNotes } = req.body;
  const adminId = req.user!.id;

  if (!Array.isArray(reportIds) || reportIds.length === 0) {
    return res.status(400).json({ message: 'Aucun signalement sélectionné' });
  }

  if (reportIds.length > BULK_REPORT_LIMIT) {
    return res.status(400).json({
      message: `Traitement limité à ${BULK_REPORT_LIMIT} signalements à la fois`
    });
  }

  if (!RESOLVABLE_STATUSES.includes(status)) {
    return res.status(400).json({
      message: `Statut invalide. Doit être ${RESOLVABLE_STATUSES.join(', ')}`
    });
  }

  const validIds = reportIds.filter((id: unknown) =>
    typeof id === 'string' && mongoose.Types.ObjectId.isValid(id)
  );

  if (validIds.length === 0) {
    return res.status(400).json({ message: 'Aucun identifiant de signalement valide' });
  }

  const update: Record<string, unknown> = { status };
  if (adminNotes) update.adminNotes = String(adminNotes).slice(0, REPORT_TEXT_MAX_LENGTH);
  if (status === 'resolved') update.resolvedAt = new Date();

  const result = await Report.updateMany({ _id: { $in: validIds } }, { $set: update });
  const matched = result.matchedCount ?? 0;

  logger.info('Signalements traités en lot', { adminId, status, count: matched });

  await recordAuditLog({
    adminId,
    action: `report_bulk_${status}`,
    targetType: 'report',
    details: `${matched} signalement(s) marqué(s) « ${status} »`,
    metadata: { reportIds: validIds, adminNotes }
  });

  return res.status(200).json({
    message: `${matched} signalement(s) mis à jour`,
    updated: matched
  });
});

/**
 * Mettre à jour le statut d'un signalement (admin)
 */
export const updateReportStatus = asyncHandler(async (req: Request, res: Response) => {
  const reportId = req.params.reportId as string;
  const { status, adminNotes } = req.body;
  const adminId = req.user!.id;
  
  if (!status || !RESOLVABLE_STATUSES.includes(status)) {
    return res.status(400).json({
      message: 'Statut invalide. Doit être "reviewed", "resolved" ou "rejected"'
    });
  }

  const report = mongoose.Types.ObjectId.isValid(reportId) ? await Report.findById(reportId) : null;

  if (!report) {
    return res.status(404).json({ message: 'Signalement non trouvé' });
  }

  // Mettre à jour le signalement
  report.status = status;
  if (adminNotes) {
    report.adminNotes = String(adminNotes).slice(0, REPORT_TEXT_MAX_LENGTH);
  }
  
  if (status === 'resolved') {
    report.resolvedAt = new Date();
  }
  
  await report.save();
  
  logger.info('Statut du signalement mis à jour', {
    reportId,
    adminId,
    newStatus: status
  });

  await recordAuditLog({
    adminId,
    action: `report_${status}`,
    targetType: 'report',
    targetId: reportId,
    details: `Signalement (${REASON_LABELS[report.reason] || report.reason}) marqué « ${status} »`,
    metadata: { targetType: report.targetType, targetId: report.targetId, adminNotes }
  });

  return res.status(200).json({
    message: 'Statut du signalement mis à jour avec succès',
    report
  });
});