import IdentityVerification from '../../../models/identityVerificationModel';
import User from '../../../models/userModel';
import { secureStoreDocument, deleteSecureDocument } from '../../../commons/services/secureStorageService';
import { sendVerificationResultEmail } from '../../../commons/services/emailService';
import { HttpError } from '../../../commons/utils/httpError';
import logger from '../../../commons/utils/logger';
import { recordAuditLog } from '../../../commons/utils/auditService';

const VALID_DOCUMENT_TYPES = ['id_card', 'passport', 'driver_license'];

function safelyDeleteDocument(referenceId: string) {
  try {
    deleteSecureDocument(referenceId);
  } catch (error) {
    logger.error('Erreur lors de la suppression du document d\'identité', { error });
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

  const existingVerification = await IdentityVerification.findOne({
    user: userId,
    status: 'pending'
  });

  if (existingVerification) {
    throw new HttpError(409, 'Une demande de vérification est déjà en cours de traitement');
  }

  const documentReferenceId = await secureStoreDocument(fileBuffer, mimetype, documentType);

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30);

  const verification = new IdentityVerification({
    user: userId,
    documentType,
    documentReferenceId,
    expiresAt
  });

  await verification.save();

  logger.info(`Demande de vérification d'identité soumise: ${verification._id}`, {
    userId,
    verificationType: documentType
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

  await User.findByIdAndUpdate(verification.user, {
    isIdentityVerified: true,
    identityVerifiedAt: new Date(),
    verificationLevel: 'complete'
  });

  const user = await User.findById(verification.user);
  if (user?.email) {
    await sendVerificationResultEmail(user.email, true);
  }

  safelyDeleteDocument(verification.documentReferenceId);

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

  const user = await User.findById(verification.user);
  if (user?.email) {
    await sendVerificationResultEmail(user.email, false, reason);
  }

  safelyDeleteDocument(verification.documentReferenceId);

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
