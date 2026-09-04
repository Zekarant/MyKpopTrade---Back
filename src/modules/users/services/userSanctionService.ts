import User from '../../../models/userModel';
import { HttpError } from '../../../commons/utils/httpError';
import logger from '../../../commons/utils/logger';
import { recordAuditLog } from '../../../commons/utils/auditService';
import { NotificationService } from '../../notifications/services/notificationService';
import { dispatchAdminAlert } from '../../../commons/services/adminAlertService';

export const SUSPENSION_DURATIONS_DAYS = [1, 7, 30, 90] as const;

const MIN_REASON_LENGTH = 5;
const MAX_REASON_LENGTH = 500;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const normalizeReason = (reason: unknown): string => {
  if (typeof reason !== 'string' || reason.trim().length < MIN_REASON_LENGTH) {
    throw new HttpError(
      400,
      `Le motif est obligatoire et doit contenir au moins ${MIN_REASON_LENGTH} caractères`
    );
  }
  return reason.trim().slice(0, MAX_REASON_LENGTH);
};

const resolveSuspensionEnd = (durationDays: unknown): Date | undefined => {
  if (durationDays === null || durationDays === undefined) return undefined;

  const days = Number(durationDays);
  if (!SUSPENSION_DURATIONS_DAYS.includes(days as any)) {
    throw new HttpError(
      400,
      `Durée invalide. Valeurs acceptées : ${SUSPENSION_DURATIONS_DAYS.join(', ')} jours, ou aucune pour une suspension définitive`
    );
  }
  return new Date(Date.now() + days * MS_PER_DAY);
};

const loadSanctionableUser = async (userId: string) => {
  const user = await User.findById(userId);
  if (!user) {
    throw new HttpError(404, 'Utilisateur non trouvé');
  }
  if (user.role === 'admin') {
    throw new HttpError(403, 'Impossible de modifier le statut d\'un administrateur');
  }
  return user;
};

const formatDeadline = (until?: Date): string =>
  until ? `jusqu'au ${until.toLocaleDateString('fr-FR')}` : 'de façon définitive';

export async function suspendUser({
  adminId,
  userId,
  reason,
  durationDays
}: {
  adminId: string;
  userId: string;
  reason: unknown;
  durationDays: unknown;
}) {
  const motive = normalizeReason(reason);
  const until = resolveSuspensionEnd(durationDays);
  const user = await loadSanctionableUser(userId);
  const suspendedAt = new Date();

  user.accountStatus = 'suspended';
  user.suspension = { reason: motive, until, suspendedAt, suspendedBy: adminId as any };
  user.sanctions = [
    ...(user.sanctions ?? []),
    { action: 'suspend', reason: motive, until, at: suspendedAt, by: adminId as any }
  ];
  await user.save({ validateBeforeSave: false });

  await recordAuditLog({
    adminId,
    action: 'suspend_user',
    targetType: 'user',
    targetId: userId,
    details: `${user.username} suspendu ${formatDeadline(until)} — ${motive}`,
    metadata: { reason: motive, until }
  });

  await NotificationService.createNotification({
    recipientId: userId,
    type: 'system',
    title: 'Votre compte a été suspendu',
    content: `Votre compte est suspendu ${formatDeadline(until)}. Motif : ${motive}`,
    link: '/contact',
    data: { reason: motive, until }
  }).catch((error) => {
    logger.warn('Notification de suspension non délivrée', {
      userId: userId.substring(0, 5) + '...',
      error: error instanceof Error ? error.message : String(error)
    });
  });

  dispatchAdminAlert({
    event: 'user.suspended',
    severity: 'info',
    title: `Compte suspendu : ${user.username}`,
    summary: `Suspension ${formatDeadline(until)}.`,
    adminTab: 'users',
    fields: [
      { name: 'Motif', value: motive },
      { name: 'Échéance', value: until ? until.toISOString().slice(0, 10) : 'définitive', inline: true }
    ],
    data: { userId, until }
  });

  return user;
}

export async function reactivateUser({
  adminId,
  userId,
  reason
}: {
  adminId: string;
  userId: string;
  reason?: unknown;
}) {
  const user = await loadSanctionableUser(userId);
  const motive = typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, MAX_REASON_LENGTH) : undefined;

  user.accountStatus = 'active';
  user.suspension = undefined;
  user.sanctions = [
    ...(user.sanctions ?? []),
    { action: 'unsuspend', reason: motive, at: new Date(), by: adminId as any }
  ];
  await user.save({ validateBeforeSave: false });

  await recordAuditLog({
    adminId,
    action: 'reactivate_user',
    targetType: 'user',
    targetId: userId,
    details: `${user.username} réactivé${motive ? ` — ${motive}` : ''}`
  });

  await NotificationService.createNotification({
    recipientId: userId,
    type: 'system',
    title: 'Votre compte a été réactivé',
    content: 'Votre compte est de nouveau actif. Merci de respecter nos conditions d\'utilisation.',
    link: '/adherents/dashboard'
  }).catch((error) => {
    logger.warn('Notification de réactivation non délivrée', {
      userId: userId.substring(0, 5) + '...',
      error: error instanceof Error ? error.message : String(error)
    });
  });

  return user;
}

export async function liftExpiredSuspensions(): Promise<number> {
  const expired = await User.find({
    accountStatus: 'suspended',
    'suspension.until': { $ne: null, $lte: new Date() }
  }).select('username suspension sanctions accountStatus');

  for (const user of expired) {
    user.accountStatus = 'active';
    user.suspension = undefined;
    user.sanctions = [
      ...(user.sanctions ?? []),
      { action: 'unsuspend', reason: 'Fin automatique de la suspension', at: new Date() }
    ];
    await user.save({ validateBeforeSave: false });

    await NotificationService.createNotification({
      recipientId: user._id as any,
      type: 'system',
      title: 'Votre compte a été réactivé',
      content: 'Votre période de suspension est terminée, votre compte est de nouveau actif.',
      link: '/adherents/dashboard'
    }).catch(() => {
    });
  }

  if (expired.length > 0) {
    logger.info('Suspensions arrivées à échéance levées', { count: expired.length });
  }

  return expired.length;
}
