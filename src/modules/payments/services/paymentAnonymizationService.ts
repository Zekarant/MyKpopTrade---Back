import mongoose from 'mongoose';
import Payment, { IPayment } from '../../../models/paymentModel';
import { forEachPaymentBatch } from './paymentBatches';

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
function erasePersonalDataOperation(payment: IPayment): mongoose.AnyBulkWriteOperation<IPayment> {
  const $unset: Record<string, 1> = { shippingAddress: 1 };
  // `$[]` échoue si le tableau n'existe pas : on ne le vise que s'il y a des événements.
  if (payment.shipment?.events?.length) {
    $unset['shipment.events.$[].location'] = 1;
  }
  return {
    updateOne: {
      filter: { _id: payment._id },
      update: { $set: { ipAddress: '0.0.0.0', userAgent: 'anonymized', anonymized: true }, $unset }
    }
  };
}

/** Anonymise par lots, une écriture groupée par lot plutôt qu'un save() par paiement. */
async function anonymizePayments(filter: mongoose.QueryFilter<IPayment>): Promise<number> {
  let anonymized = 0;
  await forEachPaymentBatch(
    { ...filter, anonymized: { $ne: true } },
    async (payments) => {
      const result = await Payment.bulkWrite(payments.map(erasePersonalDataOperation), { ordered: false });
      anonymized += result.modifiedCount;
    },
    { select: '_id shipment.events' }
  );
  return anonymized;
}

/** Anonymise les paiements terminés depuis plus de 3 ans (tâche planifiée). */
export async function anonymizeExpiredPayments(now = new Date()): Promise<number> {
  const cutoffDate = new Date(now);
  cutoffDate.setFullYear(cutoffDate.getFullYear() - PERSONAL_DATA_RETENTION_YEARS);

  return anonymizePayments({
    status: { $in: ['completed', 'refunded', 'partially_refunded'] },
    updatedAt: { $lt: cutoffDate }
  });
}

/**
 * Anonymise, à la demande de l'acheteur, ses paiements clos. Une commande en
 * cours garde son adresse : le vendeur en a besoin pour expédier ; elle sera
 * anonymisée par la tâche planifiée une fois close.
 */
export async function anonymizeBuyerPayments(buyerId: string): Promise<number> {
  return anonymizePayments({ buyer: buyerId, ...CLOSED_PAYMENT_FILTER });
}
