import { QueryFilter, isValidObjectId } from 'mongoose';
import TransactionProof, { ITransactionProof } from '../../../models/transactionProofModel';
import User from '../../../models/userModel';
import { HttpError, userNotFound } from '../../../commons/utils/httpError';
import { PageRequest, paginationMeta } from '../../../commons/utils/pagination';

/**
 * Preuves de transaction : captures que les membres soumettent pour attester
 * de ventes, achats ou échanges conclus hors plateforme. Elles alimentent les
 * indicateurs de confiance du profil public. À ne pas confondre avec la
 * vérification d'identité (pièce officielle, module `verification`).
 */

const PROOF_TYPES = ['sale', 'purchase', 'exchange'] as const;
const MAX_PROOF_IMAGES = 5;

/**
 * Les preuves en attente ou refusées ne regardent que leur auteur et les
 * administrateurs (rôle relu en base, comme requireAdmin).
 */
async function canSeeUnverifiedProofs(viewerId: string | undefined, ownerId: string): Promise<boolean> {
  if (!viewerId) return false;
  if (viewerId === ownerId) return true;
  const viewer = await User.findById(viewerId).select('role').lean<{ role?: string } | null>();
  return viewer?.role === 'admin';
}

/**
 * Preuves d'un membre, les plus récentes d'abord. Seules les preuves vérifiées
 * sont publiques ; `includeAll` n'est honoré que pour l'auteur ou un admin.
 */
export async function listUserProofs({
  ownerId,
  viewerId,
  includeAll,
  pageRequest
}: {
  ownerId: string;
  viewerId?: string;
  includeAll: boolean;
  pageRequest: PageRequest;
}) {
  const showAll = includeAll && await canSeeUnverifiedProofs(viewerId, ownerId);
  const filter: QueryFilter<ITransactionProof> = {
    user: ownerId,
    status: showAll ? { $in: ['pending', 'verified', 'rejected'] } : 'verified'
  };

  const [proofs, total] = await Promise.all([
    TransactionProof.find(filter)
      .sort({ createdAt: -1 })
      .skip(pageRequest.skip)
      .limit(pageRequest.limit)
      .lean(),
    TransactionProof.countDocuments(filter)
  ]);

  return { proofs, pagination: paginationMeta(pageRequest, total) };
}

export interface NewTransactionProof {
  type: unknown;
  images: unknown;
  description: unknown;
  otherParty?: unknown;
}

/**
 * Enregistre une preuve, en attente de vérification par un administrateur.
 * @throws HttpError 400 si le type, les images ou la description sont invalides
 */
export async function submitTransactionProof(userId: string, { type, images, description, otherParty }: NewTransactionProof) {
  if (!type || !images || !description) {
    throw new HttpError(400, 'Type, images et description sont obligatoires');
  }
  if (!Array.isArray(images) || images.length === 0 || images.length > MAX_PROOF_IMAGES) {
    throw new HttpError(400, `Entre 1 et ${MAX_PROOF_IMAGES} images sont requises`);
  }
  if (!PROOF_TYPES.includes(type as typeof PROOF_TYPES[number])) {
    throw new HttpError(400, 'Le type doit être "sale", "purchase" ou "exchange"');
  }

  return TransactionProof.create({
    user: userId,
    type: type as ITransactionProof['type'],
    images: images as ITransactionProof['images'],
    description: description as ITransactionProof['description'],
    otherParty: otherParty as ITransactionProof['otherParty']
  });
}

/** Nombre de preuves par statut, ventes et achats d'un membre. */
export async function getVerificationStats(userId: string) {
  // Un id mal formé ferait lever un CastError : c'est un utilisateur inconnu.
  const user = isValidObjectId(userId)
    ? await User.findById(userId, { username: 1, statistics: 1 }).lean()
    : null;
  if (!user) {
    throw userNotFound();
  }

  const stats = await TransactionProof.aggregate<{ status?: string; count: number }>([
    { $match: { user: user._id } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
    { $project: { status: '$_id', count: 1, _id: 0 } }
  ]);

  const byStatus = { verified: 0, pending: 0, rejected: 0, total: 0 };
  for (const stat of stats) {
    if (stat.status && Object.hasOwn(byStatus, stat.status)) {
      byStatus[stat.status as keyof typeof byStatus] = stat.count;
      byStatus.total += stat.count;
    }
  }

  return {
    username: user.username,
    statistics: {
      ...byStatus,
      totalSales: user.statistics?.totalSales || 0,
      totalPurchases: user.statistics?.totalPurchases || 0
    }
  };
}
