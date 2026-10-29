import User from '../../../models/userModel';
import Product from '../../../models/productModel';
import { recordAuditLog } from '../../../commons/utils/auditService';
import { dispatchAdminAlert } from '../../../commons/services/adminAlertService';
import { escapeRegex } from '../../../commons/utils/escapeRegex';
import { badRequest, forbidden, notFound, userNotFound } from '../../../commons/utils/httpError';
import { eraseUserAccount } from './accountErasureService';

const IDENTIFIER_NOT_FOUND_MESSAGE = 'Utilisateur introuvable';

/** Champs jamais exportés, même vers un admin : secrets et notes internes. */
const EXPORT_EXCLUDED_FIELDS = '-password -emailVerificationToken -passwordResetToken -phoneVerificationCode -adminNotes';

/**
 * Filtre sur le pseudo ou l'email exact (insensible à la casse) : un motif
 * comme `.*` ne doit jamais désigner un membre arbitraire pour un export ou
 * une anonymisation irréversible.
 */
function exactIdentifierFilter(identifier: unknown) {
  if (!identifier || typeof identifier !== 'string') {
    throw badRequest('Paramètre de recherche requis');
  }
  const exactPattern = `^${escapeRegex(identifier)}$`;
  return {
    $or: [
      { username: { $regex: exactPattern, $options: 'i' } },
      { email: { $regex: exactPattern, $options: 'i' } }
    ]
  };
}

export async function listDeletionRequests() {
  return User.find({ scheduledForDeletion: true })
    .select('username email scheduledDeletionDate createdAt')
    .sort({ scheduledDeletionDate: 1 })
    .lean();
}

/** Consentements RGPD recueillis. */
export async function getConsentCounts() {
  const [privacyAccepted, dataProcessing, marketing] = await Promise.all([
    User.countDocuments({ privacyPolicyAccepted: true }),
    User.countDocuments({ dataProcessingConsent: true }),
    User.countDocuments({ marketingConsent: true })
  ]);

  return { privacyAccepted, dataProcessing, marketing };
}

/** Export des données d'un membre désigné par son pseudo ou son email (Art. 15). */
export async function exportUserDataByIdentifier(identifier: unknown) {
  const user = await User.findOne(exactIdentifierFilter(identifier)).select(EXPORT_EXCLUDED_FIELDS).lean();
  if (!user) {
    throw notFound(IDENTIFIER_NOT_FOUND_MESSAGE);
  }

  const products = await Product.find({ seller: user._id }).select('-__v').lean();

  return { exportDate: new Date().toISOString(), user, products };
}

/** Anonymise un membre désigné par son pseudo ou son email (Art. 17). */
export async function anonymizeUserByIdentifier({ adminId, identifier }: { adminId: string; identifier: unknown }) {
  const user = await User.findOne(exactIdentifierFilter(identifier)).select('role').lean();
  if (!user) {
    throw notFound(IDENTIFIER_NOT_FOUND_MESSAGE);
  }
  if (user.role === 'admin') {
    throw forbidden('Impossible d\'anonymiser un administrateur', 'ADMIN_PROTECTED');
  }

  const { pseudonym: anonymizedId } = await eraseUserAccount(user._id.toString());

  await recordAuditLog({
    adminId,
    action: 'anonymize_user',
    targetType: 'user',
    targetId: user._id,
    details: 'Utilisateur anonymisé (RGPD Art. 17)',
    metadata: { anonymizedId }
  });

  dispatchAdminAlert({
    event: 'gdpr.user_anonymized',
    severity: 'info',
    title: 'Utilisateur anonymisé',
    summary: 'Anonymisation effectuée par un administrateur (RGPD Art. 17).',
    adminTab: 'rgpd',
    fields: [{ name: 'Identifiant anonymisé', value: anonymizedId, inline: true }],
    data: { anonymizedId }
  });
}

/** Exécute une demande de suppression : le compte est effacé et anonymisé. */
export async function confirmAccountDeletion({ adminId, userId }: { adminId: string; userId: string }) {
  const { pseudonym: anonymizedId } = await eraseUserAccount(userId);

  await recordAuditLog({
    adminId,
    action: 'confirm_deletion',
    targetType: 'user',
    targetId: userId,
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
}

export async function cancelDeletionRequestByAdmin({ adminId, userId }: { adminId: string; userId: string }) {
  const user = await User.findByIdAndUpdate(
    userId,
    { $set: { scheduledForDeletion: false }, $unset: { scheduledDeletionDate: 1 } },
    { runValidators: false }
  )
    .select('_id')
    .lean();
  if (!user) {
    throw userNotFound();
  }

  await recordAuditLog({
    adminId,
    action: 'cancel_deletion',
    targetType: 'user',
    targetId: userId,
    details: 'Demande de suppression annulée'
  });
}
