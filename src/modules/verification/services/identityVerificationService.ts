import IdentityVerification from '../../../models/identityVerificationModel';
import User from '../../../models/userModel';
import {
  secureStoreDocument,
  deleteSecureDocument,
  retrieveSecureDocument,
  cleanExpiredDocuments
} from '../../../commons/services/secureStorageService';
import { sendVerificationResultEmail } from '../../../commons/services/emailService';
import { HttpError } from '../../../commons/utils/httpError';
import logger from '../../../commons/utils/logger';
import { recordAuditLog } from '../../../commons/utils/auditService';
import { dispatchAdminAlert } from '../../../commons/services/adminAlertService';

const VALID_DOCUMENT_TYPES = ['id_card', 'passport', 'driver_license'];

const DOCUMENT_TYPE_LABELS: Record<string, string> = {
  id_card: 'Carte d\'identité',
  passport: 'Passeport',
  driver_license: 'Permis de conduire'
};

/**
 * Type réel d'une image d'après ses premiers octets (« magic bytes »). Le
 * `mimetype` de multer vient du client et ne prouve rien : un PDF ou un HTML
 * déclaré `image/png` ferait échouer le floutage en silence.
 */
export function detectIdentityImageType(buffer: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

/** Libellé donné à une demande restée sans examen au-delà de son échéance. */
const EXPIRED_REJECTION_REASON =
  'Demande expirée sans examen : votre document a été supprimé, vous pouvez en soumettre un nouveau.';

function safelyDeleteDocument(referenceId: string) {
  try {
    deleteSecureDocument(referenceId);
  } catch (error) {
    logger.error('Erreur lors de la suppression du document d\'identité', { error });
  }
}

/**
 * Prévient l'utilisateur du résultat. Un échec d'envoi (SMTP indisponible) ne
 * doit pas faire échouer la décision, déjà enregistrée.
 */
async function notifyVerificationResult(userId: string, approved: boolean, reason?: string) {
  const user = await User.findById(userId).select('email');
  if (!user?.email) return;
  try {
    if (approved) {
      await sendVerificationResultEmail(user.email, true);
    } else {
      await sendVerificationResultEmail(user.email, false, reason);
    }
  } catch (error) {
    logger.error('Email de résultat de vérification non envoyé', {
      userId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function loadPendingVerification(verificationId: string) {
  let verification;
  try {
    verification = await IdentityVerification.findById(verificationId);
  } catch (error) {
    logger.error(`Erreur lors de la recherche de la vérification: ${verificationId}`, { error });
    throw new HttpError(400, 'ID de vérification invalide');
  }

  if (!verification) {
    logger.warn(`Vérification non trouvée: ${verificationId}`);
    throw new HttpError(404, 'Demande de vérification non trouvée');
  }

  if (verification.status !== 'pending') {
    throw new HttpError(400, 'Cette demande a déjà été traitée');
  }

  return verification;
}

export async function submitIdentityVerification({
  userId,
  documentType,
  consentGiven,
  fileBuffer,
  mimetype
}: {
  userId: string;
  documentType: string;
  consentGiven: unknown;
  fileBuffer?: Buffer;
  mimetype?: string;
}) {
  if (!fileBuffer || !mimetype) {
    throw new HttpError(400, 'Document d\'identité requis');
  }

  if (consentGiven !== 'true' && consentGiven !== true) {
    throw new HttpError(
      400,
      'Vous devez consentir explicitement à la collecte et au traitement de votre pièce d\'identité après avoir pris connaissance de nos mentions légales'
    );
  }

  if (!VALID_DOCUMENT_TYPES.includes(documentType)) {
    throw new HttpError(400, 'Type de document invalide');
  }

  const detectedType = detectIdentityImageType(fileBuffer);
  if (!detectedType) {
    throw new HttpError(400, 'Format non supporté : envoyez une photo JPEG, PNG ou WebP de votre document');
  }

  const existingVerification = await IdentityVerification.findOne({
    user: userId,
    status: 'pending'
  });

  if (existingVerification) {
    throw new HttpError(409, 'Une demande de vérification est déjà en cours de traitement');
  }

  const documentReferenceId = await secureStoreDocument(fileBuffer, detectedType, documentType);

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30);

  const verification = new IdentityVerification({
    user: userId,
    documentType,
    documentReferenceId,
    consentGivenAt: new Date(),
    expiresAt
  });

  try {
    await verification.save();
  } catch (error) {
    // Doublon détecté par l'index unique (user, status: 'pending') : deux
    // soumissions quasi simultanées ont toutes les deux passé le contrôle
    // `existingVerification` ci-dessus avant que l'une des deux n'insère.
    if ((error as { code?: number }).code === 11000) {
      safelyDeleteDocument(documentReferenceId);
      throw new HttpError(409, 'Une demande de vérification est déjà en cours de traitement');
    }
    throw error;
  }

  logger.info(`Demande de vérification d'identité soumise: ${verification._id}`, {
    userId,
    verificationType: documentType
  });

  const applicant = await User.findById(userId).select('username');

  dispatchAdminAlert({
    event: 'verification.submitted',
    severity: 'warning',
    title: `Vérification d'identité à examiner : ${applicant?.username || 'utilisateur inconnu'}`,
    summary: `Document de type « ${DOCUMENT_TYPE_LABELS[documentType] || documentType} » déposé.`,
    adminTab: 'verifications',
    fields: [{ name: 'Utilisateur', value: applicant?.username || 'inconnu', inline: true }],
    data: { verificationId: verification._id, documentType }
  });

  return {
    id: verification._id,
    status: verification.status,
    documentType: verification.documentType,
    submittedAt: verification.submittedAt
  };
}

export async function fetchVerificationStatus(userId: string) {
  const verification = await IdentityVerification.findOne({ user: userId })
    .sort({ submittedAt: -1 });

  if (!verification) {
    throw new HttpError(404, 'Aucune demande de vérification trouvée');
  }

  const user = await User.findById(userId, {
    isIdentityVerified: 1,
    identityVerifiedAt: 1,
    verificationLevel: 1
  });

  return {
    verification: {
      id: verification._id,
      status: verification.status,
      documentType: verification.documentType,
      submittedAt: verification.submittedAt,
      processedAt: verification.processedAt,
      rejectionReason: verification.rejectionReason
    },
    userVerification: {
      isVerified: user?.isIdentityVerified || false,
      verifiedAt: user?.identityVerifiedAt,
      level: user?.verificationLevel || 'none'
    }
  };
}

export async function approveIdentityVerification({
  verificationId,
  adminId
}: {
  verificationId: string;
  adminId: string;
}) {
  if (!verificationId) {
    throw new HttpError(400, 'ID de vérification requis');
  }

  logger.debug(`Tentative d'approbation de la vérification: ${verificationId}`, { adminId });

  const verification = await loadPendingVerification(verificationId);

  verification.status = 'approved';
  verification.processedAt = new Date();
  verification.processedBy = adminId;
  await verification.save();
  // Supprimé avant l'email : la demande n'étant plus « pending », un échec
  // d'envoi laisserait le document sur le disque pour toujours.
  safelyDeleteDocument(verification.documentReferenceId);

  await User.findByIdAndUpdate(verification.user, {
    isIdentityVerified: true,
    identityVerifiedAt: new Date(),
    verificationLevel: 'complete'
  });

  await notifyVerificationResult(String(verification.user), true);

  await recordAuditLog({
    adminId,
    action: 'verification_approved',
    targetType: 'verification',
    targetId: verification._id as any,
    metadata: { userId: String(verification.user) }
  });

  logger.info(`Demande de vérification approuvée: ${verificationId}`, {
    adminId,
    userId: verification.user
  });
}

export async function rejectIdentityVerification({
  verificationId,
  adminId,
  reason
}: {
  verificationId: string;
  adminId: string;
  reason: string;
}) {
  if (!reason) {
    throw new HttpError(400, 'Motif de rejet requis');
  }

  const verification = await loadPendingVerification(verificationId);

  verification.status = 'rejected';
  verification.processedAt = new Date();
  verification.processedBy = adminId;
  verification.rejectionReason = reason;
  await verification.save();
  safelyDeleteDocument(verification.documentReferenceId);

  await notifyVerificationResult(String(verification.user), false, reason);

  await recordAuditLog({
    adminId,
    action: 'verification_rejected',
    targetType: 'verification',
    targetId: verification._id as any,
    details: reason,
    metadata: { userId: String(verification.user) }
  });

  logger.info(`Demande de vérification rejetée: ${verificationId}`, {
    adminId,
    userId: verification.user,
    reason
  });
}

export async function listPendingVerifications(adminId: string, page: number, limit: number) {
  const admin = await User.findById(adminId);
  if (!admin || admin.role !== 'admin') {
    throw new HttpError(403, 'Accès non autorisé');
  }

  const [verifications, total] = await Promise.all([
    IdentityVerification.find({ status: 'pending' })
      .populate('user', 'username email')
      .sort({ submittedAt: 1 })
      .skip((page - 1) * limit)
      .limit(limit),
    IdentityVerification.countDocuments({ status: 'pending' })
  ]);

  return {
    verifications,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit)
    }
  };
}

/**
 * Document d'une demande en attente, déchiffré pour l'examen par un admin.
 * Chaque consultation est tracée dans l'audit log (accès à une donnée d'identité).
 */
export async function getVerificationDocumentForAdmin(verificationId: string, adminId: string) {
  const verification = await loadPendingVerification(verificationId);

  let document;
  try {
    document = retrieveSecureDocument(verification.documentReferenceId);
  } catch (error) {
    logger.error('Document d\'identité illisible', {
      verificationId,
      error: error instanceof Error ? error.message : String(error)
    });
    throw new HttpError(404, 'Document introuvable ou expiré');
  }

  await recordAuditLog({
    adminId,
    action: 'verification_document_viewed',
    targetType: 'verification',
    targetId: verification._id as any,
    metadata: { userId: String(verification.user) }
  });

  return { buffer: document.buffer, contentType: String(document.metadata.type || 'image/jpeg') };
}

/**
 * Clôt les demandes restées sans examen au-delà de `expiresAt` et supprime
 * leur document, puis purge les fichiers orphelins expirés.
 */
export async function expireStaleVerifications(now = new Date()) {
  const stale = await IdentityVerification.find({ status: 'pending', expiresAt: { $lt: now } });

  for (const verification of stale) {
    safelyDeleteDocument(verification.documentReferenceId);
    verification.status = 'rejected';
    verification.processedAt = now;
    verification.rejectionReason = EXPIRED_REJECTION_REASON;
    await verification.save();
  }

  cleanExpiredDocuments();

  if (stale.length > 0) {
    logger.info('Demandes de vérification expirées clôturées', { count: stale.length });
  }
  return stale.length;
}

export async function cancelUserVerification(userId: string) {
  const verification = await IdentityVerification.findOne({
    user: userId,
    status: 'pending'
  });

  if (!verification) {
    throw new HttpError(404, 'Aucune demande de vérification en cours trouvée');
  }

  safelyDeleteDocument(verification.documentReferenceId);

  await verification.deleteOne();

  logger.info(`Demande de vérification annulée par l'utilisateur: ${verification._id}`, { userId });
}
