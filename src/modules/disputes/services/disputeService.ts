import mongoose from 'mongoose';
import Dispute, { DisputeReason, DisputeStatus } from '../../../models/disputeModel';
import Payment from '../../../models/paymentModel';
import { HttpError } from '../../../commons/utils/httpError';
import { NotificationService } from '../../notifications/services/notificationService';
import { processRefund } from '../../payments/services/paymentService';
import logger from '../../../commons/utils/logger';
import { recordAuditLog } from '../../../commons/utils/auditService';
import { dispatchAdminAlert } from '../../../commons/services/adminAlertService';

const VALID_REASONS: DisputeReason[] = [
  'not_received', 'damaged', 'not_as_described', 'counterfeit',
  'wrong_item', 'partial_delivery', 'seller_unresponsive', 'buyer_abuse', 'other'
];

const ACTIVE_STATUSES: DisputeStatus[] = ['opened', 'under_review'];
const TERMINAL_STATUSES: DisputeStatus[] = ['resolved', 'refunded', 'rejected', 'cancelled'];
const RESOLUTION_OUTCOMES: DisputeStatus[] = ['resolved', 'refunded', 'rejected'];

const DISPUTE_WINDOW_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface OpenDisputeInput {
  userId: string;
  paymentId: string;
  reason: unknown;
  description: unknown;
  evidence?: unknown;
}

function assertString(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HttpError(400, `${label} requis`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new HttpError(400, `${label} dépasse ${max} caractères`);
  }
  return trimmed;
}

function assertEvidenceUrls(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new HttpError(400, 'evidence doit être un tableau d\'URLs');
  }
  return value.map((url, idx) => {
    if (typeof url !== 'string' || url.trim().length === 0) {
      throw new HttpError(400, `evidence[${idx}] invalide`);
    }
    const trimmed = url.trim();
    if (trimmed.length > 500) {
      throw new HttpError(400, `evidence[${idx}] dépasse 500 caractères`);
    }
    if (!/^https?:\/\//i.test(trimmed) && !trimmed.startsWith('/uploads/')) {
      throw new HttpError(400, `evidence[${idx}] doit être une URL ou un chemin /uploads/`);
    }
    return trimmed;
  });
}

async function loadActiveDisputeOnPayment(paymentId: string) {
  return Dispute.findOne({
    payment: paymentId,
    status: { $in: ACTIVE_STATUSES }
  });
}

/**
 * Ouvre un litige sur un paiement. L'auteur doit être l'acheteur ou le
 * vendeur du paiement. Le paiement doit être complété et la fenêtre
 * d'ouverture (30 jours après la livraison ou expédition) ne doit pas
 * être expirée.
 */
export async function openDispute({
  userId, paymentId, reason, description, evidence
}: OpenDisputeInput) {
  if (!mongoose.Types.ObjectId.isValid(paymentId)) {
    throw new HttpError(400, 'paymentId invalide');
  }
  if (typeof reason !== 'string' || !VALID_REASONS.includes(reason as DisputeReason)) {
    throw new HttpError(400, 'reason invalide');
  }
  const desc = assertString(description, 'description', 2000);
  const evidenceUrls = assertEvidenceUrls(evidence);

  const payment = await Payment.findById(paymentId);
  if (!payment) {
    throw new HttpError(404, 'Paiement non trouvé');
  }

  const buyerId = payment.buyer.toString();
  const sellerId = payment.seller.toString();
  let openedByRole: 'buyer' | 'seller';
  if (userId === buyerId) openedByRole = 'buyer';
  else if (userId === sellerId) openedByRole = 'seller';
  else {
    throw new HttpError(403, 'Seuls l\'acheteur et le vendeur peuvent ouvrir un litige', 'DISPUTE_FORBIDDEN');
  }

  if (payment.status !== 'completed' && payment.status !== 'partially_refunded') {
    throw new HttpError(400, 'Litige possible uniquement sur un paiement complété', 'DISPUTE_INVALID_STATE');
  }

  // Fenêtre d'ouverture : 30 jours après la livraison (ou expédition si pas livré)
  const reference = payment.shipment?.deliveredAt
    ?? payment.shipment?.shippedAt
    ?? payment.completedAt
    ?? payment.createdAt;
  if (reference && Date.now() - new Date(reference).getTime() > DISPUTE_WINDOW_DAYS * MS_PER_DAY) {
    throw new HttpError(400, `Délai d'ouverture dépassé (${DISPUTE_WINDOW_DAYS} jours)`, 'DISPUTE_WINDOW_EXPIRED');
  }

  const existing = await loadActiveDisputeOnPayment(paymentId);
  if (existing) {
    throw new HttpError(409, 'Un litige est déjà ouvert sur ce paiement', 'DISPUTE_ALREADY_OPEN');
  }

  const dispute = await Dispute.create({
    payment: payment._id,
    buyer: payment.buyer,
    seller: payment.seller,
    openedBy: userId,
    openedByRole,
    reason,
    description: desc,
    evidence: evidenceUrls,
    status: 'opened',
    messages: [{
      author: userId,
      authorRole: openedByRole,
      content: desc,
      attachments: evidenceUrls,
      createdAt: new Date()
    }]
  });

  // Notifie l'autre partie
  const other = openedByRole === 'buyer' ? payment.seller : payment.buyer;
  await NotificationService.createNotification({
    recipientId: other,
    type: 'dispute_opened',
    title: 'Un litige a été ouvert sur votre transaction',
    content: `Motif : ${reason}. Merci de répondre depuis votre espace litiges.`,
    link: `/disputes/${dispute._id}`,
    data: { disputeId: dispute._id, paymentId, reason }
  });

  // Notifie tous les admins pour qu'ils puissent prendre le litige en main.
  dispatchAdminAlert({
    event: 'dispute.opened',
    severity: 'warning',
    title: 'Nouveau litige à arbitrer',
    summary: `Litige ouvert par ${openedByRole === 'buyer' ? 'l\'acheteur' : 'le vendeur'} (motif : ${reason}).`,
    adminTab: 'disputes',
    fields: [
      { name: 'Ouvert par', value: openedByRole === 'buyer' ? 'Acheteur' : 'Vendeur', inline: true },
      { name: 'Motif', value: reason, inline: true },
      { name: 'Description', value: desc }
    ],
    data: { disputeId: dispute._id, paymentId, reason, openedByRole }
  });

  logger.info('Dispute ouvert', {
    disputeId: dispute._id?.toString(),
    paymentId,
    openedBy: userId.substring(0, 5) + '...'
  });

  return dispute;
}

async function loadDisputeForUser(disputeId: string, userId: string, isAdmin = false) {
  if (!mongoose.Types.ObjectId.isValid(disputeId)) {
    throw new HttpError(400, 'disputeId invalide');
  }
  const dispute = await Dispute.findById(disputeId);
  if (!dispute) {
    throw new HttpError(404, 'Litige non trouvé');
  }
  if (
    !isAdmin
    && dispute.buyer.toString() !== userId
    && dispute.seller.toString() !== userId
  ) {
    throw new HttpError(403, 'Accès refusé', 'DISPUTE_FORBIDDEN');
  }
  return dispute;
}

/** Ajoute un message à un litige actif. Tout participant ou admin peut écrire. */
export async function addDisputeMessage({
  userId, disputeId, content, attachments, isAdmin = false
}: {
  userId: string;
  disputeId: string;
  content: unknown;
  attachments?: unknown;
  isAdmin?: boolean;
}) {
  const text = assertString(content, 'content', 2000);
  const files = assertEvidenceUrls(attachments);

  const dispute = await loadDisputeForUser(disputeId, userId, isAdmin);
  if (TERMINAL_STATUSES.includes(dispute.status)) {
    throw new HttpError(400, 'Le litige est clôturé', 'DISPUTE_CLOSED');
  }

  let role: 'buyer' | 'seller' | 'admin';
  if (isAdmin) role = 'admin';
  else if (dispute.buyer.toString() === userId) role = 'buyer';
  else role = 'seller';

  dispute.messages.push({
    author: new mongoose.Types.ObjectId(userId),
    authorRole: role,
    content: text,
    attachments: files,
    createdAt: new Date()
  });
  await dispute.save();

  // Notifie les autres participants
  const recipients = role === 'admin'
    ? [dispute.buyer, dispute.seller]
    : [role === 'buyer' ? dispute.seller : dispute.buyer];
  await Promise.all(recipients.map((r) => NotificationService.createNotification({
    recipientId: r,
    type: 'order_status',
    title: 'Nouveau message dans votre litige',
    content: text.length > 100 ? text.substring(0, 100) + '…' : text,
    link: `/disputes/${dispute._id}`,
    data: { disputeId: dispute._id }
  }).catch(() => undefined)));

  return dispute;
}

/** Retire un litige (par le plaignant uniquement). */
export async function cancelDispute(userId: string, disputeId: string) {
  const dispute = await loadDisputeForUser(disputeId, userId);
  if (dispute.openedBy.toString() !== userId) {
    throw new HttpError(403, 'Seul le plaignant peut retirer le litige', 'DISPUTE_FORBIDDEN');
  }
  if (TERMINAL_STATUSES.includes(dispute.status)) {
    throw new HttpError(400, 'Le litige est déjà clôturé', 'DISPUTE_CLOSED');
  }
  dispute.status = 'cancelled';
  dispute.closedAt = new Date();
  await dispute.save();

  await NotificationService.createNotification({
    recipientId: dispute.openedByRole === 'buyer' ? dispute.seller : dispute.buyer,
    type: 'order_status',
    title: 'Litige retiré',
    content: 'Le plaignant a retiré le litige.',
    link: `/disputes/${dispute._id}`,
    data: { disputeId: dispute._id }
  }).catch(() => undefined);

  return dispute;
}

/** Admin : prend le litige en main (status passe à under_review). */
export async function takeDisputeUnderReview(adminId: string, disputeId: string) {
  const dispute = await loadDisputeForUser(disputeId, adminId, true);
  if (dispute.status !== 'opened') {
    throw new HttpError(400, 'Seul un litige ouvert peut être pris en revue', 'DISPUTE_INVALID_STATE');
  }
  dispute.status = 'under_review';
  await dispute.save();

  await recordAuditLog({
    adminId,
    action: 'dispute_taken_under_review',
    targetType: 'dispute',
    targetId: dispute._id as any,
    metadata: { paymentId: dispute.payment.toString() }
  });

  // Notifier les deux parties que le litige est en cours d'arbitrage.
  await Promise.all([dispute.buyer, dispute.seller].map((r) =>
    NotificationService.createNotification({
      recipientId: r,
      type: 'dispute_message',
      title: 'Votre litige est en cours d\'arbitrage',
      content: 'Un membre de l\'équipe de modération étudie votre dossier.',
      link: `/disputes/${dispute._id}`,
      data: { disputeId: dispute._id }
    }).catch(() => undefined)
  ));

  return dispute;
}

/**
 * Admin : tranche le litige.
 *  - 'resolved' : le seller a raison, pas de remboursement.
 *  - 'refunded' : le buyer a raison, déclenche un refund (total ou partiel).
 *  - 'rejected' : le litige est rejeté (manque de preuve, hors périmètre…).
 */
export async function resolveDispute({
  adminId, disputeId, outcome, notes, refundAmount
}: {
  adminId: string;
  disputeId: string;
  outcome: unknown;
  notes?: unknown;
  refundAmount?: unknown;
}) {
  if (typeof outcome !== 'string' || !RESOLUTION_OUTCOMES.includes(outcome as DisputeStatus)) {
    throw new HttpError(400, 'outcome invalide (resolved | refunded | rejected)');
  }
  const dispute = await loadDisputeForUser(disputeId, adminId, true);
  if (TERMINAL_STATUSES.includes(dispute.status)) {
    throw new HttpError(400, 'Le litige est déjà clôturé', 'DISPUTE_CLOSED');
  }

  const notesStr = notes !== undefined && notes !== null && notes !== ''
    ? assertString(notes, 'notes', 2000)
    : undefined;

  let refundAmountNum: number | undefined;
  if (outcome === 'refunded') {
    if (refundAmount !== undefined && refundAmount !== null && refundAmount !== '') {
      const parsed = parseFloat(refundAmount as string);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new HttpError(400, 'refundAmount invalide');
      }
      refundAmountNum = parsed;
    }
    // Déclenche le remboursement PayPal (plein si refundAmount non précisé)
    try {
      await processRefund({
        userId: adminId,
        paymentId: dispute.payment.toString(),
        amount: refundAmountNum,
        reason: `Litige #${dispute._id} — ${notesStr ?? 'résolution administrative'}`
      });
    } catch (error) {
      logger.error('Erreur refund pendant résolution dispute', {
        disputeId: dispute._id?.toString(),
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  dispute.status = outcome as DisputeStatus;
  dispute.resolution = {
    decidedBy: new mongoose.Types.ObjectId(adminId),
    decidedAt: new Date(),
    outcome: outcome as DisputeStatus,
    notes: notesStr,
    refundAmount: refundAmountNum
  };
  dispute.closedAt = new Date();
  await dispute.save();

  // Notifie les deux parties
  const verdictLabel = outcome === 'refunded'
    ? 'Litige résolu : remboursement effectué'
    : outcome === 'resolved'
      ? 'Litige résolu en faveur du vendeur'
      : 'Litige rejeté';

  await Promise.all([dispute.buyer, dispute.seller].map((r) =>
    NotificationService.createNotification({
      recipientId: r,
      type: 'dispute_resolved',
      title: verdictLabel,
      content: notesStr || 'Le litige a été clôturé par l\'équipe de modération.',
      link: `/disputes/${dispute._id}`,
      data: { disputeId: dispute._id, outcome }
    }).catch(() => undefined)
  ));

  await recordAuditLog({
    adminId,
    action: `dispute_${outcome}`,
    targetType: 'dispute',
    targetId: dispute._id as any,
    details: notesStr,
    metadata: {
      paymentId: dispute.payment.toString(),
      refundAmount: refundAmountNum,
      outcome
    }
  });

  return dispute;
}

export async function getDispute(userId: string, disputeId: string, isAdmin = false) {
  return loadDisputeForUser(disputeId, userId, isAdmin);
}

export async function listMyDisputes(userId: string, page = 1, limit = 10) {
  const safeLimit = Math.min(Math.max(limit, 1), 50);
  const safePage = Math.max(page, 1);
  const filter = { $or: [{ buyer: userId }, { seller: userId }] };
  const [disputes, total] = await Promise.all([
    Dispute.find(filter)
      .sort({ createdAt: -1 })
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit)
      .populate('payment', 'amount currency status product')
      .populate('buyer', 'username profilePicture')
      .populate('seller', 'username profilePicture'),
    Dispute.countDocuments(filter)
  ]);
  return {
    disputes,
    pagination: {
      page: safePage,
      limit: safeLimit,
      total,
      pages: Math.ceil(total / safeLimit)
    }
  };
}

export async function listAllDisputes({
  status, page = 1, limit = 20
}: { status?: string; page?: number; limit?: number } = {}) {
  const safeLimit = Math.min(Math.max(limit, 1), 100);
  const safePage = Math.max(page, 1);
  const filter: any = {};
  if (status) filter.status = status;
  const [disputes, total] = await Promise.all([
    Dispute.find(filter)
      .sort({ createdAt: -1 })
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit)
      .populate('payment', 'amount currency status product')
      .populate('buyer', 'username email')
      .populate('seller', 'username email'),
    Dispute.countDocuments(filter)
  ]);
  return {
    disputes,
    pagination: {
      page: safePage,
      limit: safeLimit,
      total,
      pages: Math.ceil(total / safeLimit)
    }
  };
}
