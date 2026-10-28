import mongoose from 'mongoose';
import Payment, { IPayment } from '../../../models/paymentModel';

/** Taille des lots des tâches planifiées : borne la mémoire et la durée de chaque requête. */
export const PAYMENT_BATCH_SIZE = 100;

/**
 * Parcourt par lots bornés les paiements qui correspondent à `filter`, triés
 * par `_id` (pagination par clé). Pas de curseur Mongo ouvert pendant le
 * traitement : un lot (appels transporteur, emails) peut dépasser le délai
 * d'inactivité d'un curseur. Un paiement déjà traité n'est jamais revu, même
 * si le traitement le modifie.
 */
export async function forEachPaymentBatch(
  filter: mongoose.QueryFilter<IPayment>,
  onBatch: (payments: IPayment[]) => Promise<void>,
  { select, batchSize = PAYMENT_BATCH_SIZE }: { select?: string; batchSize?: number } = {}
): Promise<void> {
  let lastId: mongoose.Types.ObjectId | undefined;

  for (;;) {
    const query = Payment.find(lastId ? { $and: [filter, { _id: { $gt: lastId } }] } : filter)
      .sort({ _id: 1 })
      .limit(batchSize);
    if (select) query.select(select);

    const batch = await query;
    if (batch.length === 0) return;

    await onBatch(batch);

    if (batch.length < batchSize) return;
    lastId = batch[batch.length - 1]._id;
  }
}
