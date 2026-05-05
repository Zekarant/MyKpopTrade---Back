import Payment from '../../../models/paymentModel';
import { NotificationService } from '../../notifications/services/notificationService';
import { HttpError } from '../../../commons/utils/httpError';
import logger from '../../../commons/utils/logger';
import {
  sendShipmentShippedEmail,
  sendShipmentDeliveredEmail,
  sendShipmentReminderEmail,
  sendShipmentAutoConfirmedEmail
} from '../../../commons/services/emailService';
import User from '../../../models/userModel';
import { getTrackingProvider } from './tracking';
import { TrackingEventStatus } from './tracking/types';

const SHIPMENT_STATUS = {
  SHIPPED: 'shipped',
  DELIVERED: 'delivered'
} as const;

const PAYMENT_STATUS_COMPLETED = 'completed';

const ERROR_CODES = {
  SHIPMENT_FORBIDDEN: 'SHIPMENT_FORBIDDEN',
  SHIPMENT_INVALID_STATE: 'SHIPMENT_INVALID_STATE'
} as const;

/**
 * Délais d'automatisation. Surchargeables via env pour ajuster sans redeploy.
 * AUTO_CONFIRM_DAYS : auto-confirme la livraison si l'acheteur n'agit pas.
 * REMINDER_DAYS     : envoie une relance email à l'acheteur après ce délai.
 * REMINDER_COOLDOWN_DAYS : délai minimum entre deux relances pour un même colis.
 */
const AUTO_CONFIRM_DAYS = Number(process.env.SHIPMENT_AUTO_CONFIRM_DAYS) || 14;
const REMINDER_DAYS = Number(process.env.SHIPMENT_REMINDER_DAYS) || 7;
const REMINDER_COOLDOWN_DAYS = 5;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const CARRIER_TRACKING_URL: Record<string, string> = {
  'la poste': 'https://www.laposte.fr/outils/suivre-vos-envois?code={tracking}',
  'laposte': 'https://www.laposte.fr/outils/suivre-vos-envois?code={tracking}',
  'colissimo': 'https://www.laposte.fr/outils/suivre-vos-envois?code={tracking}',
  'mondial relay': 'https://www.mondialrelay.com/suivi-de-colis/?numeroExpedition={tracking}',
  'mondialrelay': 'https://www.mondialrelay.com/suivi-de-colis/?numeroExpedition={tracking}',
  'chronopost': 'https://www.chronopost.fr/tracking-no-cms/suivi-page?listeNumerosLT={tracking}',
  'relais colis': 'https://www.relaiscolis.com/suivi-de-colis/?txtNumeroColis={tracking}',
  'relaiscolis': 'https://www.relaiscolis.com/suivi-de-colis/?txtNumeroColis={tracking}',
  'ups': 'https://www.ups.com/track?tracknum={tracking}',
  'dhl': 'https://www.dhl.com/fr-fr/home/tracking/tracking-express.html?submit=1&tracking-id={tracking}',
  'fedex': 'https://www.fedex.com/fedextrack/?tracknumbers={tracking}'
};

/**
 * Construit une URL de suivi à partir du nom du transporteur s'il est connu.
 * Renvoie null si le transporteur n'est pas dans la map (l'appelant peut alors
 * fournir une URL manuelle ou laisser vide).
 */
export function buildTrackingUrl(carrier: string, trackingNumber: string): string | null {
  const template = CARRIER_TRACKING_URL[carrier.trim().toLowerCase()];
  if (!template) return null;
  return template.replace('{tracking}', encodeURIComponent(trackingNumber));
}

function assertNonEmptyString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HttpError(400, `${label} requis`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new HttpError(400, `${label} dépasse ${maxLength} caractères`);
  }
  return trimmed;
}

function assertOptionalUrl(value: unknown, label: string, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new HttpError(400, `${label} invalide`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new HttpError(400, `${label} dépasse ${maxLength} caractères`);
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new HttpError(400, `${label} doit commencer par http:// ou https://`);
  }
  return trimmed;
}

async function loadPayment(paymentId: string) {
  const payment = await Payment.findById(paymentId);
  if (!payment) {
    throw new HttpError(404, 'Paiement non trouvé');
  }
  return payment;
}

function assertSeller(payment: any, userId: string): void {
  if (payment.seller.toString() !== userId) {
    throw new HttpError(
      403,
      'Seul le vendeur peut effectuer cette action',
      ERROR_CODES.SHIPMENT_FORBIDDEN
    );
  }
}

function assertBuyer(payment: any, userId: string): void {
  if (payment.buyer.toString() !== userId) {
    throw new HttpError(
      403,
      'Seul l\'acheteur peut confirmer la réception',
      ERROR_CODES.SHIPMENT_FORBIDDEN
    );
  }
}

function assertParticipant(payment: any, userId: string): void {
  const buyerId = payment.buyer.toString();
  const sellerId = payment.seller.toString();
  if (buyerId !== userId && sellerId !== userId) {
    throw new HttpError(
      403,
      'Vous n\'êtes pas autorisé à accéder à cette livraison',
      ERROR_CODES.SHIPMENT_FORBIDDEN
    );
  }
}

interface ShipmentEventInput {
  status: string;
  description?: string;
  location?: string;
  occurredAt?: Date;
  source: 'system' | 'seller' | 'buyer' | 'carrier';
}

function appendEvent(payment: any, event: ShipmentEventInput): void {
  if (!payment.shipment) return;
  if (!Array.isArray(payment.shipment.events)) {
    payment.shipment.events = [];
  }
  payment.shipment.events.push({
    status: event.status,
    description: event.description,
    location: event.location,
    occurredAt: event.occurredAt ?? new Date(),
    source: event.source
  });
}

export interface MarkShippedInput {
  userId: string;
  paymentId: string;
  carrier: unknown;
  trackingNumber: unknown;
  trackingUrl?: unknown;
}

export async function markShipped({
  userId,
  paymentId,
  carrier,
  trackingNumber,
  trackingUrl
}: MarkShippedInput) {
  const carrierStr = assertNonEmptyString(carrier, 'Transporteur', 50);
  const trackingStr = assertNonEmptyString(trackingNumber, 'Numéro de suivi', 100);
  const providedUrl = assertOptionalUrl(trackingUrl, 'URL de suivi', 500);

  const payment = await loadPayment(paymentId);
  assertSeller(payment, userId);

  if (payment.status !== PAYMENT_STATUS_COMPLETED) {
    throw new HttpError(
      400,
      'Le paiement doit être complété avant l\'expédition',
      ERROR_CODES.SHIPMENT_INVALID_STATE
    );
  }
  if (payment.shipment) {
    throw new HttpError(
      400,
      'Une livraison est déjà enregistrée pour ce paiement',
      ERROR_CODES.SHIPMENT_INVALID_STATE
    );
  }

  const resolvedUrl = providedUrl ?? buildTrackingUrl(carrierStr, trackingStr) ?? undefined;
  const shippedAt = new Date();

  payment.shipment = {
    carrier: carrierStr,
    trackingNumber: trackingStr,
    trackingUrl: resolvedUrl,
    status: SHIPMENT_STATUS.SHIPPED,
    shippedAt,
    events: []
  };
  appendEvent(payment, {
    status: 'shipped',
    description: `Expédié via ${carrierStr}`,
    occurredAt: shippedAt,
    source: 'seller'
  });
  await payment.save();

  await NotificationService.createNotification({
    recipientId: payment.buyer,
    type: 'order_status',
    title: 'Votre commande a été expédiée',
    content: `Le vendeur a expédié votre commande via ${carrierStr}.`,
    link: `/account/purchases/${payment._id}`,
    data: {
      paymentId: payment._id,
      carrier: carrierStr,
      trackingNumber: trackingStr,
      trackingUrl: resolvedUrl
    }
  });

  await safeSendEmail(payment.buyer, (user) =>
    sendShipmentShippedEmail(user, {
      paymentId: payment._id.toString(),
      carrier: carrierStr,
      trackingNumber: trackingStr,
      trackingUrl: resolvedUrl
    })
  );

  return payment.shipment;
}

/**
 * Marque la livraison comme confirmée. La source permet de distinguer
 * une confirmation manuelle (acheteur) d'une auto-confirmation (système)
 * ou d'un signal carrier — utile pour la timeline et les emails.
 */
async function applyDelivery(
  payment: any,
  source: 'buyer' | 'system' | 'carrier',
  occurredAt: Date = new Date()
) {
  payment.shipment.status = SHIPMENT_STATUS.DELIVERED;
  payment.shipment.deliveredAt = occurredAt;
  if (source === 'system') {
    payment.shipment.autoConfirmedAt = occurredAt;
  }
  appendEvent(payment, {
    status: 'delivered',
    description: source === 'system'
      ? 'Livraison auto-confirmée (délai dépassé)'
      : source === 'carrier'
        ? 'Livraison confirmée par le transporteur'
        : 'Livraison confirmée par l\'acheteur',
    occurredAt,
    source
  });
  await payment.save();
}

export async function confirmDelivery(userId: string, paymentId: string) {
  const payment = await loadPayment(paymentId);
  assertBuyer(payment, userId);

  if (!payment.shipment) {
    throw new HttpError(
      400,
      'Aucune expédition n\'est enregistrée pour ce paiement',
      ERROR_CODES.SHIPMENT_INVALID_STATE
    );
  }
  if (payment.shipment.status === SHIPMENT_STATUS.DELIVERED) {
    throw new HttpError(
      400,
      'Cette livraison est déjà confirmée',
      ERROR_CODES.SHIPMENT_INVALID_STATE
    );
  }

  await applyDelivery(payment, 'buyer');

  await NotificationService.createNotification({
    recipientId: payment.seller,
    type: 'order_status',
    title: 'Livraison confirmée',
    content: 'L\'acheteur a confirmé la réception du colis.',
    link: `/account/sales/${payment._id}`,
    data: {
      paymentId: payment._id,
      deliveredAt: payment.shipment.deliveredAt
    }
  });

  await safeSendEmail(payment.seller, (user) =>
    sendShipmentDeliveredEmail(user, {
      paymentId: payment._id.toString(),
      carrier: payment.shipment!.carrier,
      trackingNumber: payment.shipment!.trackingNumber
    })
  );

  return payment.shipment;
}

export async function getShipment(userId: string, paymentId: string) {
  const payment = await loadPayment(paymentId);
  assertParticipant(payment, userId);
  return payment.shipment ?? null;
}

/* ----------------------------------------------------------------------- */
/* Automatisation : polling carrier, auto-confirmation, relances            */
/* ----------------------------------------------------------------------- */

const CARRIER_TO_INTERNAL: Record<TrackingEventStatus, string> = {
  shipped: 'shipped',
  in_transit: 'in_transit',
  out_for_delivery: 'out_for_delivery',
  delivered: 'delivered',
  exception: 'exception',
  returned: 'returned',
  unknown: 'unknown'
};

/**
 * Met à jour les événements de tracking d'un paiement à partir du provider
 * configuré. Idempotent : ne rajoute que les événements postérieurs au plus
 * récent déjà connu, ce qui évite les doublons à chaque polling.
 *
 * Renvoie true si l'expédition a été marquée delivered par cette passe.
 */
export async function pollShipment(payment: any): Promise<boolean> {
  if (!payment.shipment) return false;
  if (payment.shipment.status === SHIPMENT_STATUS.DELIVERED) return false;

  const provider = getTrackingProvider();
  const result = await provider.track(
    payment.shipment.carrier,
    payment.shipment.trackingNumber
  );

  payment.shipment.lastTrackedAt = new Date();
  if (result.estimatedDeliveryAt) {
    payment.shipment.estimatedDeliveryAt = result.estimatedDeliveryAt;
  }

  const existing = payment.shipment.events ?? [];
  const lastKnown = existing.length > 0
    ? Math.max(...existing.map((e: any) => new Date(e.occurredAt).getTime()))
    : 0;

  for (const ev of result.events) {
    if (ev.occurredAt.getTime() <= lastKnown) continue;
    appendEvent(payment, {
      status: CARRIER_TO_INTERNAL[ev.status] ?? ev.status,
      description: ev.description,
      location: ev.location,
      occurredAt: ev.occurredAt,
      source: 'carrier'
    });
  }

  if (result.status === 'delivered') {
    await applyDelivery(
      payment,
      'carrier',
      result.events.find((e) => e.status === 'delivered')?.occurredAt ?? new Date()
    );
    return true;
  }

  await payment.save();
  return false;
}

/**
 * Itère sur toutes les expéditions encore en transit et tente une mise à
 * jour via le provider. Conçu pour être appelé par un cron — résiste aux
 * erreurs individuelles (un colis cassé ne stoppe pas le batch).
 */
export async function pollPendingShipments(): Promise<{ checked: number; updated: number }> {
  const pending = await Payment.find({
    'shipment.status': SHIPMENT_STATUS.SHIPPED
  });

  let updated = 0;
  for (const payment of pending) {
    try {
      const wasDelivered = await pollShipment(payment);
      if (wasDelivered) updated++;
    } catch (error) {
      logger.error('Erreur lors du polling shipment', {
        paymentId: payment._id?.toString(),
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  logger.info('Polling shipments terminé', { checked: pending.length, updated });
  return { checked: pending.length, updated };
}

/**
 * Auto-confirme les expéditions livrées dont l'acheteur n'a pas validé la
 * réception après {@link AUTO_CONFIRM_DAYS} jours. Notifie acheteur et
 * vendeur. Volontairement conservateur : on n'auto-confirme que les colis
 * shipped (pas exception/returned).
 */
export async function autoConfirmStaleShipments(): Promise<{ confirmed: number }> {
  const threshold = new Date(Date.now() - AUTO_CONFIRM_DAYS * MS_PER_DAY);

  const stale = await Payment.find({
    'shipment.status': SHIPMENT_STATUS.SHIPPED,
    'shipment.shippedAt': { $lte: threshold }
  });

  let confirmed = 0;
  for (const payment of stale) {
    try {
      await applyDelivery(payment, 'system');
      confirmed++;

      await Promise.all([
        NotificationService.createNotification({
          recipientId: payment.buyer,
          type: 'order_status',
          title: 'Livraison auto-confirmée',
          content: `Sans confirmation après ${AUTO_CONFIRM_DAYS} jours, la livraison a été automatiquement validée. Contactez le support si le colis n'est pas arrivé.`,
          link: `/account/purchases/${payment._id}`,
          data: { paymentId: payment._id, autoConfirmed: true }
        }),
        NotificationService.createNotification({
          recipientId: payment.seller,
          type: 'order_status',
          title: 'Livraison auto-confirmée',
          content: `Le délai de ${AUTO_CONFIRM_DAYS} jours est dépassé : la livraison a été automatiquement confirmée.`,
          link: `/account/sales/${payment._id}`,
          data: { paymentId: payment._id, autoConfirmed: true }
        })
      ]);

      await Promise.all([
        safeSendEmail(payment.buyer, (user) =>
          sendShipmentAutoConfirmedEmail(user, {
            paymentId: payment._id.toString(),
            role: 'buyer',
            days: AUTO_CONFIRM_DAYS
          })
        ),
        safeSendEmail(payment.seller, (user) =>
          sendShipmentAutoConfirmedEmail(user, {
            paymentId: payment._id.toString(),
            role: 'seller',
            days: AUTO_CONFIRM_DAYS
          })
        )
      ]);
    } catch (error) {
      logger.error('Erreur lors de l\'auto-confirmation', {
        paymentId: payment._id?.toString(),
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  logger.info('Auto-confirmation terminée', { confirmed });
  return { confirmed };
}

/**
 * Envoie une relance email à l'acheteur si son colis est expédié depuis
 * {@link REMINDER_DAYS} jours sans confirmation, en respectant un cooldown
 * pour ne pas spammer.
 */
export async function sendStuckShipmentReminders(): Promise<{ sent: number }> {
  const now = Date.now();
  const reminderThreshold = new Date(now - REMINDER_DAYS * MS_PER_DAY);
  const cooldownThreshold = new Date(now - REMINDER_COOLDOWN_DAYS * MS_PER_DAY);

  const candidates = await Payment.find({
    'shipment.status': SHIPMENT_STATUS.SHIPPED,
    'shipment.shippedAt': { $lte: reminderThreshold },
    $or: [
      { 'shipment.lastReminderAt': { $exists: false } },
      { 'shipment.lastReminderAt': { $lte: cooldownThreshold } }
    ]
  });

  let sent = 0;
  for (const payment of candidates) {
    try {
      await safeSendEmail(payment.buyer, (user) =>
        sendShipmentReminderEmail(user, {
          paymentId: payment._id.toString(),
          carrier: payment.shipment!.carrier,
          trackingNumber: payment.shipment!.trackingNumber,
          trackingUrl: payment.shipment!.trackingUrl,
          daysSinceShipped: Math.floor(
            (now - new Date(payment.shipment!.shippedAt).getTime()) / MS_PER_DAY
          )
        })
      );
      payment.shipment!.lastReminderAt = new Date();
      await payment.save();
      sent++;
    } catch (error) {
      logger.error('Erreur lors de la relance shipment', {
        paymentId: payment._id?.toString(),
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  logger.info('Relances shipment envoyées', { sent });
  return { sent };
}

/**
 * Envoie un email en chargeant l'utilisateur et en absorbant les erreurs :
 * un email qui plante ne doit jamais casser le flux de paiement/cron.
 */
async function safeSendEmail(
  userId: any,
  send: (user: any) => Promise<void>
): Promise<void> {
  try {
    const user = await User.findById(userId);
    if (!user || !user.email) return;
    await send(user);
  } catch (error) {
    logger.error('Erreur envoi email shipment', {
      userId: userId?.toString(),
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
