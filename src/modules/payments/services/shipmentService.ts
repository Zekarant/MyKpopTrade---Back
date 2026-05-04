import Payment from '../../../models/paymentModel';
import { NotificationService } from '../../notifications/services/notificationService';
import { HttpError } from '../../../commons/utils/httpError';

const SHIPMENT_STATUS = {
  SHIPPED: 'shipped',
  DELIVERED: 'delivered'
} as const;

const PAYMENT_STATUS_COMPLETED = 'completed';

const ERROR_CODES = {
  SHIPMENT_FORBIDDEN: 'SHIPMENT_FORBIDDEN',
  SHIPMENT_INVALID_STATE: 'SHIPMENT_INVALID_STATE'
} as const;

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

  payment.shipment = {
    carrier: carrierStr,
    trackingNumber: trackingStr,
    trackingUrl: resolvedUrl,
    status: SHIPMENT_STATUS.SHIPPED,
    shippedAt: new Date()
  };
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

  return payment.shipment;
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

  payment.shipment.status = SHIPMENT_STATUS.DELIVERED;
  payment.shipment.deliveredAt = new Date();
  await payment.save();

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

  return payment.shipment;
}

export async function getShipment(userId: string, paymentId: string) {
  const payment = await loadPayment(paymentId);
  assertParticipant(payment, userId);
  return payment.shipment ?? null;
}
