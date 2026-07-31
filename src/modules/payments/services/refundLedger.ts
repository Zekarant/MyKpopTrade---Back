import { add, gt } from '../../../commons/utils/moneyMath';
import { NotificationService } from '../../notifications/services/notificationService';

export interface RefundEntryInput {
  refundId: string;
  amount: number;
  currency: string;
  reason?: string;
  initiatedBy?: any;
}

export interface RefundLedgerResult {
  /** `false` si ce remboursement était déjà enregistré (webhook redélivré). */
  changed: boolean;
  totalRefunded: number;
  isFullyRefunded: boolean;
}

/**
 * Applique un remboursement à un paiement : ajoute l'entrée si elle est
 * nouvelle, puis recalcule `totalRefunded` et le statut à partir de
 * l'historique complet.
 *
 * Partagé entre le remboursement synchrone (réponse de l'API PayPal) et le
 * webhook `PAYMENT.CAPTURE.REFUNDED` — les deux décrivent le même fait et
 * doivent produire le même état. L'idempotence par `refundId` garantit qu'un
 * webhook redélivré ne double pas les montants.
 *
 * Ne sauvegarde pas : l'appelant décide quand persister.
 */
export function applyRefundToPayment(
  payment: any,
  entry: RefundEntryInput
): RefundLedgerResult {
  payment.refunds = payment.refunds || [];

  const existing = payment.refunds.find((r: any) => r.refundId === entry.refundId);
  let changed = false;

  if (!existing) {
    payment.refunds.push({
      refundId: entry.refundId,
      amount: entry.amount,
      currency: entry.currency,
      reason: entry.reason || undefined,
      status: 'completed',
      initiatedBy: entry.initiatedBy,
      initiatedAt: new Date(),
      settledAt: new Date()
    });
    changed = true;
  } else if (existing.status !== 'completed') {
    existing.status = 'completed';
    existing.amount = entry.amount;
    existing.settledAt = new Date();
    changed = true;
  }

  const totalRefunded = payment.refunds
    .filter((r: any) => r.status === 'completed')
    .reduce((sum: number, r: any) => add(sum, r.amount), 0);

  const isFullyRefunded = !gt(payment.amount, totalRefunded);

  payment.totalRefunded = totalRefunded;
  payment.refundAmount = totalRefunded; // legacy (back-compat)
  payment.status = isFullyRefunded ? 'refunded' : 'partially_refunded';
  payment.refundId = entry.refundId;
  payment.refundedAt = new Date();

  return { changed, totalRefunded, isFullyRefunded };
}

/**
 * Montant encore remboursable sur un paiement, d'après l'historique local.
 */
export function remainingRefundable(payment: any): number {
  const completed = (payment.refunds || [])
    .filter((r: any) => r.status === 'completed')
    .reduce((sum: number, r: any) => add(sum, r.amount), 0);

  // `totalRefunded` peut avoir été renseigné par un webhook sans que l'entrée
  // détaillée existe : on retient la valeur la plus prudente des deux.
  const alreadyRefunded = Math.max(completed, payment.totalRefunded || 0);

  return Math.max(0, Math.round((payment.amount - alreadyRefunded) * 100) / 100);
}

/**
 * Prévient acheteur et vendeur qu'un remboursement a été émis.
 * Ne fait rien si l'entrée existait déjà — un webhook redélivré ne doit pas
 * renotifier l'acheteur.
 */
export async function notifyRefund(
  payment: any,
  refundAmount: number,
  ledger: { changed: boolean; totalRefunded: number; isFullyRefunded: boolean }
): Promise<void> {
  if (!ledger.changed) return;

  const label = ledger.isFullyRefunded ? 'complet' : 'partiel';

  await NotificationService.createNotification({
    recipientId: payment.buyer,
    type: 'system',
    title: `Remboursement ${label} reçu`,
    content: `Vous avez été remboursé de ${refundAmount} ${payment.currency} pour votre achat.`,
    link: `/account/purchases/${payment._id}`,
    data: {
      paymentId: payment._id,
      productId: payment.product,
      refundAmount,
      totalRefunded: ledger.totalRefunded,
      currency: payment.currency,
      isRefund: true
    }
  });

  await NotificationService.createNotification({
    recipientId: payment.seller,
    type: 'system',
    title: `Remboursement ${label} effectué`,
    content: `Un remboursement de ${refundAmount} ${payment.currency} a été émis depuis votre compte.`,
    link: `/account/sales/${payment._id}`,
    data: {
      paymentId: payment._id,
      refundAmount,
      totalRefunded: ledger.totalRefunded,
      currency: payment.currency,
      isRefund: true
    }
  });
}
