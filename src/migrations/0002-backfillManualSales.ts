import mongoose from 'mongoose';
import Product from '../models/productModel';
import Payment from '../models/paymentModel';
import Notification from '../models/notificationModel';
import logger from '../commons/utils/logger';
import type { Migration } from './runner';

/**
 * Rétablit `isSold` sur les ventes antérieures au correctif de `markAsSold`,
 * qui ne posait que `isAvailable: false`. Ces articles s'affichent depuis en
 * « Brouillon ».
 *
 * Rien en base ne distingue une telle vente d'une annonce simplement retirée ;
 * seuls deux indices sont fiables :
 *  - un paiement encaissé pour l'article ;
 *  - la notification « a été vendu » envoyée aux utilisateurs qui l'avaient
 *    en favori (seulement si quelqu'un l'avait en favori).
 * Les autres restent à trancher par leur vendeur, qui peut désormais les
 * marquer vendus ou les remettre en vente. Ils sont journalisés pour mémoire.
 */
const PAID_SALE_STATUSES = ['completed', 'partially_refunded'] as const;

export interface ManualSalesReport {
  fromPayments: number;
  fromNotifications: number;
  /** Annonces retirées sans indice de vente : à laisser au vendeur. */
  undecided: { id: string; title: string; seller: string }[];
}

interface SaleEvidence {
  soldAt: Date;
  soldTo?: mongoose.Types.ObjectId;
}

export async function backfillManualSales({ apply }: { apply: boolean }): Promise<ManualSalesReport> {
  const candidates = await Product.find({
    isAvailable: false,
    isSold: { $ne: true },
    // Une annonce suspendue par la modération n'est pas une vente.
    'moderationFlag.suspect': { $ne: true }
  }).select('_id title seller').lean();
  const candidateIds = candidates.map((product) => product._id);

  const payments = await Payment.find({ product: { $in: candidateIds }, status: { $in: PAID_SALE_STATUSES } })
    .select('product buyer completedAt updatedAt')
    .lean();
  const notifications = await Notification.find({
    type: 'wishlist_unavailable',
    'data.reason': 'sold',
    'data.productId': { $in: candidateIds }
  }).select('data createdAt').sort({ createdAt: 1 }).lean();

  const evidence = new Map<string, SaleEvidence>();
  for (const notification of notifications) {
    const productId = String(notification.data?.productId);
    if (!evidence.has(productId)) evidence.set(productId, { soldAt: notification.createdAt });
  }
  const fromNotifications = new Set(evidence.keys());
  // Un paiement dit aussi à qui : il l'emporte sur la notification.
  for (const payment of payments) {
    const productId = String(payment.product);
    evidence.set(productId, { soldAt: payment.completedAt ?? payment.updatedAt, soldTo: payment.buyer });
    fromNotifications.delete(productId);
  }

  if (apply && evidence.size > 0) {
    await Product.bulkWrite([...evidence].map(([productId, sale]) => ({
      updateOne: {
        filter: { _id: productId, isSold: { $ne: true } },
        update: { $set: { isSold: true, ...sale } }
      }
    })));
  }

  return {
    fromPayments: evidence.size - fromNotifications.size,
    fromNotifications: fromNotifications.size,
    undecided: candidates
      .filter((product) => !evidence.has(String(product._id)))
      .map((product) => ({ id: String(product._id), title: product.title, seller: String(product.seller) }))
  };
}

export const migration: Migration = {
  id: '0002-backfillManualSales',
  description: 'Marque vendus les articles vendus à la main avant le correctif de markAsSold',
  async up() {
    const report = await backfillManualSales({ apply: true });
    logger.info('migration.backfillManualSales', {
      fromPayments: report.fromPayments,
      fromNotifications: report.fromNotifications,
      undecided: report.undecided
    });
  }
};
