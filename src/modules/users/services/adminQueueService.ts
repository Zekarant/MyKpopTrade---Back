import User, { IUser } from '../../../models/userModel';
import Product from '../../../models/productModel';
import Report from '../../../models/reportModel';
import Dispute, { DisputeStatus } from '../../../models/disputeModel';
import IdentityVerification from '../../../models/identityVerificationModel';

const QUEUE_ITEMS_PER_SOURCE = 25;

const DISPUTE_PENDING_STATUSES: DisputeStatus[] = ['opened', 'under_review'];

/** Annonce suspendue par la modération IA et pas encore revue par un admin. */
const FLAGGED_PRODUCT_FILTER = {
  isAvailable: false,
  'moderationFlag.suspect': true,
  'moderationFlag.reviewDecision': { $exists: false }
};

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

const REPORT_REASON_LABELS: Record<string, string> = {
  inappropriate_content: 'Contenu inapproprié',
  offensive_language: 'Langage offensant',
  false_information: 'Fausses informations',
  spam: 'Spam',
  fraud: 'Fraude',
  copyright_violation: 'Violation de droit d\'auteur',
  other: 'Autre'
};

const MODERATION_CATEGORY_LABELS: Record<string, string> = {
  counterfeit: 'Contrefaçon',
  off_platform_payment: 'Paiement hors plateforme',
  prohibited_item: 'Objet interdit',
  other: 'Autre'
};

type PopulatedUsername = Pick<IUser, 'username'> | null;

export interface QueueItem {
  kind: 'report' | 'dispute' | 'verification' | 'deletion' | 'product_flagged';
  id: string;
  label: string;
  detail: string;
  subject: string;
  waitingSince: Date;
  tab: string;
}

async function loadPendingItems(): Promise<QueueItem[]> {
  const [reports, disputes, verifications, deletions, flaggedProducts] = await Promise.all([
    Report.find({ status: 'pending' })
      .populate<{ reporter: PopulatedUsername }>('reporter', 'username')
      .select('reason targetType createdAt reporter')
      .sort({ createdAt: 1 })
      .limit(QUEUE_ITEMS_PER_SOURCE)
      .lean(),
    Dispute.find({ status: { $in: DISPUTE_PENDING_STATUSES } })
      .populate<{ buyer: PopulatedUsername }>('buyer', 'username')
      .populate<{ seller: PopulatedUsername }>('seller', 'username')
      .select('reason status createdAt buyer seller')
      .sort({ createdAt: 1 })
      .limit(QUEUE_ITEMS_PER_SOURCE)
      .lean(),
    IdentityVerification.find({ status: 'pending' })
      .populate<{ user: PopulatedUsername }>('user', 'username')
      .select('documentType submittedAt user')
      .sort({ submittedAt: 1 })
      .limit(QUEUE_ITEMS_PER_SOURCE)
      .lean(),
    User.find({ scheduledForDeletion: true })
      .select('username scheduledDeletionDate updatedAt')
      .sort({ scheduledDeletionDate: 1 })
      .limit(QUEUE_ITEMS_PER_SOURCE)
      .lean(),
    Product.find(FLAGGED_PRODUCT_FILTER)
      .populate<{ seller: PopulatedUsername }>('seller', 'username')
      .select('title moderationFlag seller')
      .sort({ 'moderationFlag.analyzedAt': 1 })
      .limit(QUEUE_ITEMS_PER_SOURCE)
      .lean()
  ]);

  return [
    ...reports.map((report): QueueItem => ({
      kind: 'report',
      id: String(report._id),
      label: 'Signalement',
      detail: `${REPORT_REASON_LABELS[report.reason] || report.reason} — ${report.targetType === 'product' ? 'produit' : 'avis'}`,
      subject: report.reporter?.username || 'inconnu',
      waitingSince: report.createdAt,
      tab: 'reports'
    })),
    ...disputes.map((dispute): QueueItem => ({
      kind: 'dispute',
      id: String(dispute._id),
      label: dispute.status === 'under_review' ? 'Litige en arbitrage' : 'Litige ouvert',
      detail: DISPUTE_REASON_LABELS[dispute.reason] || dispute.reason,
      subject: `${dispute.buyer?.username || '?'} → ${dispute.seller?.username || '?'}`,
      waitingSince: dispute.createdAt,
      tab: 'disputes'
    })),
    ...verifications.map((verification): QueueItem => ({
      kind: 'verification',
      id: String(verification._id),
      label: 'Vérification d\'identité',
      detail: VERIFICATION_DOCUMENT_LABELS[verification.documentType] || verification.documentType,
      subject: verification.user?.username || 'inconnu',
      waitingSince: verification.submittedAt,
      tab: 'verifications'
    })),
    ...deletions.map((user): QueueItem => ({
      kind: 'deletion',
      id: String(user._id),
      label: 'Suppression de compte',
      detail: user.scheduledDeletionDate
        ? `Échéance le ${new Date(user.scheduledDeletionDate).toLocaleDateString('fr-FR')}`
        : 'Échéance non planifiée',
      subject: user.username,
      waitingSince: user.updatedAt,
      tab: 'rgpd'
    })),
    ...flaggedProducts.map((product): QueueItem => ({
      kind: 'product_flagged',
      id: String(product._id),
      label: 'Annonce suspendue',
      detail: (product.moderationFlag?.categories || [])
        .map((category: string) => MODERATION_CATEGORY_LABELS[category] || category)
        .join(', ') || 'Modération IA',
      subject: `${product.title} — ${product.seller?.username || 'inconnu'}`,
      waitingSince: product.moderationFlag?.analyzedAt as Date,
      tab: 'suspended'
    }))
  ].sort((a, b) => new Date(a.waitingSince).getTime() - new Date(b.waitingSince).getTime());
}

async function countPendingBySource() {
  const [report, dispute, verification, deletion, suspended] = await Promise.all([
    Report.countDocuments({ status: 'pending' }),
    Dispute.countDocuments({ status: { $in: DISPUTE_PENDING_STATUSES } }),
    IdentityVerification.countDocuments({ status: 'pending' }),
    User.countDocuments({ scheduledForDeletion: true }),
    Product.countDocuments(FLAGGED_PRODUCT_FILTER)
  ]);
  return { report, dispute, verification, deletion, suspended };
}

/** File de travail admin : tout ce qui attend une décision, du plus ancien au plus récent. */
export async function getAdminQueue() {
  const [items, counts] = await Promise.all([loadPendingItems(), countPendingBySource()]);

  return {
    items,
    counts,
    total: counts.report + counts.dispute + counts.verification + counts.deletion + counts.suspended,
    oldestWaitingSince: items[0]?.waitingSince ?? null
  };
}
