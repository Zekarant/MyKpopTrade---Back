import env from '../../config/env';
import logger from '../utils/logger';
import { NotificationService } from '../../modules/notifications/services/notificationService';
import { postDiscordEmbed, type DiscordEmbedField } from './discordWebhookService';

export type AdminAlertSeverity = 'info' | 'warning' | 'critical';

export type AdminTab =
  | 'queue'
  | 'reports'
  | 'disputes'
  | 'users'
  | 'products'
  | 'moderation'
  | 'verifications'
  | 'rgpd'
  | 'audit';

export interface AdminAlert {
  event: string;
  severity: AdminAlertSeverity;
  title: string;
  summary: string;
  fields?: DiscordEmbedField[];
  adminTab?: AdminTab;
  data?: Record<string, unknown>;
  throttleMs?: number;
}

export const ALERT_BURST_COOLDOWN_MS = 10 * 60 * 1000;

const lastDispatchByEvent = new Map<string, number>();

const isThrottled = (event: string, throttleMs?: number): boolean => {
  if (!throttleMs) return false;

  const now = Date.now();
  const previous = lastDispatchByEvent.get(event);
  if (previous !== undefined && now - previous < throttleMs) return true;

  lastDispatchByEvent.set(event, now);
  return false;
};

const SEVERITY_COLORS: Record<AdminAlertSeverity, number> = {
  info: 0x3b82f6,
  warning: 0xf59e0b,
  critical: 0xef4444
};

const SEVERITY_LABELS: Record<AdminAlertSeverity, string> = {
  info: 'Info',
  warning: 'À traiter',
  critical: 'Critique'
};

const IN_APP_SEVERITIES: AdminAlertSeverity[] = ['warning', 'critical'];

const buildAdminLink = (tab?: AdminTab): string | undefined =>
  tab ? `/adherents/admin?tab=${tab}` : undefined;

const deliverAdminAlert = async (alert: AdminAlert): Promise<void> => {
  const adminLink = buildAdminLink(alert.adminTab);

  const deliveries: Promise<unknown>[] = [
    postDiscordEmbed({
      title: alert.title,
      description: alert.summary,
      url: adminLink ? `${env.FRONTEND_URL}${adminLink}` : undefined,
      color: SEVERITY_COLORS[alert.severity],
      fields: alert.fields,
      timestamp: new Date().toISOString(),
      footer: { text: `${SEVERITY_LABELS[alert.severity]} · ${alert.event}` }
    })
  ];

  if (IN_APP_SEVERITIES.includes(alert.severity)) {
    deliveries.push(
      NotificationService.notifyAllAdmins({
        type: 'admin_alert',
        title: alert.title,
        content: alert.summary,
        link: adminLink ?? null,
        data: { event: alert.event, severity: alert.severity, ...alert.data }
      })
    );
  }

  await Promise.all(deliveries);
};

export const dispatchAdminAlert = (alert: AdminAlert): void => {
  if (isThrottled(alert.event, alert.throttleMs)) return;

  void deliverAdminAlert(alert).catch((error) => {
    logger.warn('Échec de diffusion d\'une alerte admin', {
      event: alert.event,
      error: error instanceof Error ? error.message : String(error)
    });
  });
};
