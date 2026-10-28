import mongoose from 'mongoose';
import Report, {
  type IReport,
  REPORT_REASONS,
  REPORT_TARGET_TYPES,
  REPORT_TEXT_MAX_LENGTH,
  type ReportTargetType
} from '../../../models/reportModel';
import Conversation from '../../../models/conversationModel';
import User, { type IUser } from '../../../models/userModel';
import { type IMessage } from '../../../models/messageModel';
import logger from '../../../commons/utils/logger';
import { recordAuditLog } from '../../../commons/utils/auditService';
import { dispatchAdminAlert } from '../../../commons/services/adminAlertService';
import { buildCsvFile, CSV_EXPORT_ROW_LIMIT, CsvFile } from '../../../commons/utils/csv';
import { badRequest, forbidden, notFound } from '../../../commons/utils/httpError';
import { PageRequest, paginationMeta } from '../../../commons/utils/pagination';
import { describeReportTarget, excerpt, findReportTarget, loadReportTargetView } from './reportTargetService';

/** Code MongoDB d'une violation d'index unique. */
const DUPLICATE_KEY_ERROR = 11000;

const REPORT_STATUSES: IReport['status'][] = ['pending', 'reviewed', 'resolved', 'rejected'];
export const RESOLVABLE_STATUSES: IReport['status'][] = ['reviewed', 'resolved', 'rejected'];
const BULK_REPORT_LIMIT = 100;

const ALREADY_REPORTED_MESSAGE = 'Vous avez déjà signalé cet élément';
const REPORT_NOT_FOUND_MESSAGE = 'Signalement non trouvé';

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
  post: 'Publication',
  message: 'Message'
};

const reasonLabel = (reason: string) => REASON_LABELS[reason] || reason;
const targetTypeLabel = (targetType: string) => TARGET_TYPE_LABELS[targetType] || targetType;

const isReason = (value: unknown): value is (typeof REPORT_REASONS)[number] =>
  typeof value === 'string' && (REPORT_REASONS as readonly string[]).includes(value);

export const isReportTargetType = (value: unknown): value is ReportTargetType =>
  typeof value === 'string' && REPORT_TARGET_TYPES.includes(value as ReportTargetType);

const isReportStatus = (value: unknown): value is IReport['status'] =>
  typeof value === 'string' && (REPORT_STATUSES as string[]).includes(value);

const isResolvableStatus = (value: unknown): value is IReport['status'] =>
  typeof value === 'string' && (RESOLVABLE_STATUSES as string[]).includes(value);

const isDuplicateKeyError = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === DUPLICATE_KEY_ERROR;

/** Valide le type et l'identifiant d'une cible fournis par le client. */
export function assertValidTarget(targetType: unknown, targetId: unknown): asserts targetType is ReportTargetType {
  if (!isReportTargetType(targetType)) {
    throw badRequest(`Type de cible invalide. Valeurs acceptées : ${REPORT_TARGET_TYPES.join(', ')}`);
  }
  if (typeof targetId !== 'string' || !mongoose.Types.ObjectId.isValid(targetId)) {
    throw badRequest('ID de cible invalide');
  }
}

export interface ReportInput {
  targetType: unknown;
  targetId: unknown;
  reason: unknown;
  details: unknown;
}

/**
 * Un message privé n'est signalable que par l'autre participant de sa
 * conversation : un tiers ne doit ni le désigner ni en exposer le contenu
 * aux modérateurs.
 */
async function assertMessageReportable(message: Pick<IMessage, 'sender' | 'conversation'>, reporterId: string) {
  if (String(message.sender) === String(reporterId)) {
    throw badRequest('Vous ne pouvez pas signaler votre propre message');
  }
  const isParticipant = await Conversation.exists({ _id: message.conversation, participants: reporterId });
  if (!isParticipant) {
    throw forbidden('Vous ne participez pas à cette conversation');
  }
}

export async function createReport(reporterId: string, { targetType, targetId, reason, details }: ReportInput) {
  if (!targetType || !targetId || !reason) {
    throw badRequest('Le type de cible, l\'ID de la cible et la raison sont obligatoires');
  }
  assertValidTarget(targetType, targetId);
  const target = String(targetId);
  // Validés ici plutôt que par le schéma, pour des messages explicites.
  if (!isReason(reason)) {
    throw badRequest(`Motif invalide. Valeurs acceptées : ${REPORT_REASONS.join(', ')}`);
  }
  if (details !== undefined && details !== null && (typeof details !== 'string' || details.length > REPORT_TEXT_MAX_LENGTH)) {
    throw badRequest(`Les détails sont limités à ${REPORT_TEXT_MAX_LENGTH} caractères`);
  }
  const detailsText = typeof details === 'string' ? details : '';
  if (targetType === 'user' && target === String(reporterId)) {
    throw badRequest('Vous ne pouvez pas signaler votre propre profil');
  }

  const targetDoc = await findReportTarget(targetType, target);
  if (!targetDoc) {
    throw notFound('Cible du signalement non trouvée');
  }
  if (targetType === 'message') {
    await assertMessageReportable(targetDoc as IMessage, reporterId);
  }

  const existingReport = await Report.findOne({ reporter: reporterId, targetType, targetId: target }).select('_id').lean();
  if (existingReport) {
    throw badRequest(ALREADY_REPORTED_MESSAGE, 'ALREADY_REPORTED', { reportId: existingReport._id });
  }

  const report = new Report({
    reporter: reporterId,
    targetType,
    targetId: target,
    reason,
    details: detailsText,
    status: 'pending',
    ...(targetType === 'message' && { reportedContent: (targetDoc as IMessage).content })
  });

  try {
    await report.save();
  } catch (error) {
    // Double envoi simultané : l'index unique a refusé le second.
    if (isDuplicateKeyError(error)) {
      throw badRequest(ALREADY_REPORTED_MESSAGE, 'ALREADY_REPORTED');
    }
    throw error;
  }

  logger.info('Nouveau signalement créé', { reportId: report._id, targetType, targetId: target, userId: reporterId });

  const reporter = await User.findById(reporterId).select('username').lean();
  const label = reasonLabel(report.reason);

  dispatchAdminAlert({
    event: 'report.created',
    severity: 'warning',
    title: `Nouveau signalement : ${label}`,
    summary: `${targetTypeLabel(targetType)} signalé par ${reporter?.username || 'un utilisateur'}.`,
    adminTab: 'reports',
    fields: [
      { name: 'Signaleur', value: reporter?.username || 'inconnu', inline: true },
      { name: 'Type de cible', value: targetTypeLabel(targetType), inline: true },
      { name: 'Cible', value: describeReportTarget(targetType, targetDoc) },
      ...(detailsText ? [{ name: 'Détails', value: excerpt(detailsText) }] : [])
    ],
    data: { reportId: report._id, targetType, targetId: target }
  });

  return report;
}

/** Signalements déposés par un membre ; un statut inconnu est ignoré. */
export async function listReportsByReporter(reporterId: string, status: string | undefined, pageRequest: PageRequest) {
  const filter: mongoose.QueryFilter<IReport> = { reporter: reporterId };
  if (isReportStatus(status)) filter.status = status;

  const [reports, total] = await Promise.all([
    Report.find(filter).sort({ createdAt: -1 }).skip(pageRequest.skip).limit(pageRequest.limit).lean(),
    Report.countDocuments(filter)
  ]);

  return { reports, pagination: paginationMeta(pageRequest, total) };
}

export async function findReportByReporter(reporterId: string, targetType: ReportTargetType, targetId: string) {
  return Report.findOne({ reporter: reporterId, targetType, targetId }).select('status reason createdAt').lean();
}

export interface ReportListFilters {
  status?: string;
  targetType?: string;
}

function buildReportListFilter({ status, targetType }: ReportListFilters): mongoose.QueryFilter<IReport> {
  const filter: mongoose.QueryFilter<IReport> = {};
  if (isReportStatus(status)) filter.status = status;
  if (isReportTargetType(targetType)) filter.targetType = targetType;
  return filter;
}

export async function listReports(filters: ReportListFilters, pageRequest: PageRequest) {
  const filter = buildReportListFilter(filters);
  const [reports, total] = await Promise.all([
    Report.find(filter)
      .populate('reporter', 'username profilePicture')
      .sort({ createdAt: -1 })
      .skip(pageRequest.skip)
      .limit(pageRequest.limit)
      .lean(),
    Report.countDocuments(filter)
  ]);

  return { reports, pagination: paginationMeta(pageRequest, total) };
}

export async function buildReportsCsv(filters: ReportListFilters): Promise<CsvFile> {
  const rows = await Report.find(buildReportListFilter(filters))
    .populate<{ reporter: Pick<IUser, 'username' | 'email'> | null }>('reporter', 'username email')
    .sort({ createdAt: -1 })
    .limit(CSV_EXPORT_ROW_LIMIT)
    .lean();

  return buildCsvFile('signalements', rows, [
    { header: 'Date', value: (r) => r.createdAt },
    { header: 'Signaleur', value: (r) => r.reporter?.username },
    { header: 'Email signaleur', value: (r) => r.reporter?.email },
    { header: 'Type de cible', value: (r) => targetTypeLabel(r.targetType) },
    { header: 'ID cible', value: (r) => r.targetId },
    { header: 'Motif', value: (r) => reasonLabel(r.reason) },
    { header: 'Détails', value: (r) => r.details },
    { header: 'Statut', value: (r) => r.status },
    { header: 'Notes admin', value: (r) => r.adminNotes },
    { header: 'Résolu le', value: (r) => r.resolvedAt }
  ]);
}

/** Détail admin : signalement, cible et historique du signaleur et de la cible. */
export async function getReportDetail(reportId: string) {
  if (!mongoose.Types.ObjectId.isValid(reportId)) {
    throw badRequest('ID de signalement invalide');
  }

  const report = await Report.findById(reportId)
    .populate('reporter', 'username email profilePicture accountStatus role createdAt');
  if (!report) {
    throw notFound(REPORT_NOT_FOUND_MESSAGE);
  }

  // `reporter` est peuplé : l'agrégation ne caste pas, il faut l'ObjectId d'origine.
  const reporterId = report.populated('reporter') ?? report.reporter;

  // Compter côté base : un signaleur prolifique ne doit pas faire charger
  // tous ses signalements en mémoire pour afficher quatre compteurs.
  const [target, reporterStatusCounts, targetReports] = await Promise.all([
    loadReportTargetView(report.targetType, report.targetId),
    Report.aggregate<{ _id: IReport['status']; count: number }>([
      { $match: { reporter: reporterId } },
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]),
    Report.countDocuments({ targetType: report.targetType, targetId: report.targetId })
  ]);

  const countByStatus = (status: IReport['status']) =>
    reporterStatusCounts.find((bucket) => bucket._id === status)?.count ?? 0;

  return {
    report,
    reasonLabel: reasonLabel(report.reason),
    target,
    reporterHistory: {
      total: reporterStatusCounts.reduce((sum, bucket) => sum + bucket.count, 0),
      resolved: countByStatus('resolved'),
      rejected: countByStatus('rejected'),
      pending: countByStatus('pending')
    },
    targetHistory: { totalReports: targetReports }
  };
}

const truncateNotes = (adminNotes: unknown) => String(adminNotes).slice(0, REPORT_TEXT_MAX_LENGTH);

/** Change le statut de plusieurs signalements ; renvoie le nombre de signalements concernés. */
export async function bulkUpdateReportStatus({
  adminId,
  reportIds,
  status,
  adminNotes
}: {
  adminId: string;
  reportIds: unknown;
  status: unknown;
  adminNotes?: unknown;
}): Promise<number> {
  if (!Array.isArray(reportIds) || reportIds.length === 0) {
    throw badRequest('Aucun signalement sélectionné');
  }
  if (reportIds.length > BULK_REPORT_LIMIT) {
    throw badRequest(`Traitement limité à ${BULK_REPORT_LIMIT} signalements à la fois`);
  }
  if (!isResolvableStatus(status)) {
    throw badRequest(`Statut invalide. Doit être ${RESOLVABLE_STATUSES.join(', ')}`);
  }

  const validIds = reportIds.filter((id: unknown): id is string =>
    typeof id === 'string' && mongoose.Types.ObjectId.isValid(id)
  );
  if (validIds.length === 0) {
    throw badRequest('Aucun identifiant de signalement valide');
  }

  const update: Record<string, unknown> = { status };
  if (adminNotes) update.adminNotes = truncateNotes(adminNotes);
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

  return matched;
}

export async function updateReportStatus({
  adminId,
  reportId,
  status,
  adminNotes
}: {
  adminId: string;
  reportId: string;
  status: unknown;
  adminNotes?: unknown;
}) {
  if (!isResolvableStatus(status)) {
    throw badRequest('Statut invalide. Doit être "reviewed", "resolved" ou "rejected"');
  }

  const report = mongoose.Types.ObjectId.isValid(reportId) ? await Report.findById(reportId) : null;
  if (!report) {
    throw notFound(REPORT_NOT_FOUND_MESSAGE);
  }

  report.status = status;
  if (adminNotes) report.adminNotes = truncateNotes(adminNotes);
  if (status === 'resolved') report.resolvedAt = new Date();
  await report.save();

  logger.info('Statut du signalement mis à jour', { reportId, adminId, newStatus: status });

  await recordAuditLog({
    adminId,
    action: `report_${status}`,
    targetType: 'report',
    targetId: reportId,
    details: `Signalement (${reasonLabel(report.reason)}) marqué « ${status} »`,
    metadata: { targetType: report.targetType, targetId: report.targetId, adminNotes }
  });

  return report;
}
