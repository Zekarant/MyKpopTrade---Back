import mongoose from 'mongoose';
import Payment, { IPayment } from '../../../models/paymentModel';

/** Durée de conservation des données personnelles d'un paiement (politique de confidentialité). */
const PERSONAL_DATA_RETENTION_YEARS = 3;

/** Paiements clos : plus aucune expédition ni remboursement ne dépend de l'adresse. */
const CLOSED_PAYMENT_FILTER: mongoose.QueryFilter<IPayment> = {
  $or: [
    { status: { $in: ['refunded', 'cancelled', 'failed'] } },
    { status: { $in: ['completed', 'partially_refunded'] }, 'shipment.status': 'delivered' }
  ]
};

/**
 * Efface les données personnelles d'un paiement en gardant ce que la
 * comptabilité exige (montants, dates, statut, références PayPal).
 */
function erasePersonalData(payment: IPayment): void {
  payment.ipAddress = '0.0.0.0';
  payment.userAgent = 'anonymized';
  payment.shippingAddress = undefined;
  for (const event of payment.shipment?.events ?? []) {
    event.location = undefined;
  }
  payment.anonymized = true;
}

/** Anonymise les paiements terminés depuis plus de 3 ans (tâche planifiée). */
export async function anonymizeExpiredPayments(now = new Date()): Promise<number> {
  const cutoffDate = new Date(now);
  cutoffDate.setFullYear(cutoffDate.getFullYear() - PERSONAL_DATA_RETENTION_YEARS);

  const payments = await Payment.find({
    status: { $in: ['completed', 'refunded', 'partially_refunded'] },
    updatedAt: { $lt: cutoffDate },
    anonymized: { $ne: true }
  }).select('+ipAddress +userAgent');

  for (const payment of payments) {
    erasePersonalData(payment);
    await payment.save();
  }
  return payments.length;
}

/**
 * Anonymise, à la demande de l'acheteur, ses paiements clos. Une commande en
 * cours garde son adresse : le vendeur en a besoin pour expédier ; elle sera
 * anonymisée par la tâche planifiée une fois close.
 */
export async function anonymizeBuyerPayments(buyerId: string): Promise<number> {
  const payments = await Payment.find({
    buyer: buyerId,
    anonymized: { $ne: true },
    ...CLOSED_PAYMENT_FILTER
  }).select('+ipAddress +userAgent');

  for (const payment of payments) {
    erasePersonalData(payment);
    await payment.save();
  }
  return payments.length;
}
