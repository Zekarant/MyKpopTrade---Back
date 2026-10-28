import Payment, { IPayment } from '../../../models/paymentModel';
import { IProduct } from '../../../models/productModel';
import User from '../../../models/userModel';
import { GdprLogger } from '../../../commons/utils/gdprLogger';
import { HttpError, notFound } from '../../../commons/utils/httpError';
import { anonymizeBuyerPayments, anonymizeExpiredPayments } from './paymentAnonymizationService';

export interface ExportedPayment {
  transaction_id: string;
  external_reference?: string;
  date: string;
  completed_at: string | null;
  amount: number;
  currency: string;
  status: IPayment['status'];
  payment_method: IPayment['paymentMethod'];
  product: { id: string; title: string; price: number; currency: string } | null;
  role: 'buyer' | 'seller';
  refund?: { amount: number; date: string | null; reference?: string };
}

/**
 * Paiements de l'utilisateur (achats et ventes) dans un format portable
 * (droit à la portabilité). Rien sur l'autre partie, pour respecter sa vie privée.
 */
export async function exportUserPayments(userId: string): Promise<ExportedPayment[]> {
  const payments = await Payment.find({
    $or: [{ buyer: userId }, { seller: userId }]
  })
    .populate<{ product: Pick<IProduct, '_id' | 'title' | 'price' | 'currency'> | null }>('product', 'title images price currency')
    .sort({ createdAt: -1 })
    .lean();

  const exported = payments.map((payment) => {
    const { product } = payment;
    const exportedPayment: ExportedPayment = {
      transaction_id: payment._id.toString(),
      external_reference: payment.captureId || payment.paymentIntentId,
      date: payment.createdAt.toISOString(),
      completed_at: payment.completedAt ? payment.completedAt.toISOString() : null,
      amount: payment.amount,
      currency: payment.currency,
      status: payment.status,
      payment_method: payment.paymentMethod,
      product: product ? {
        id: product._id.toString(),
        title: product.title,
        price: product.price,
        currency: product.currency
      } : null,
      role: payment.buyer.toString() === userId ? 'buyer' : 'seller'
    };

    if (payment.refundAmount) {
      exportedPayment.refund = {
        amount: payment.refundAmount,
        date: payment.refundedAt ? payment.refundedAt.toISOString() : null,
        reference: payment.refundId
      };
    }

    return exportedPayment;
  });

  GdprLogger.logPaymentAction('export_payment_data', { count: exported.length }, userId);

  return exported;
}

/**
 * Anonymise, à la demande de l'acheteur et après confirmation par mot de passe,
 * ses paiements clos. Renvoie le nombre de paiements anonymisés.
 */
export async function anonymizeOwnPayments(userId: string, password: string): Promise<number> {
  const user = await User.findById(userId).select('+password');
  if (!user) {
    throw notFound('Utilisateur non trouvé');
  }

  if (!(await user.comparePassword(password))) {
    throw new HttpError(400, 'Mot de passe incorrect', 'INVALID_PASSWORD');
  }

  const count = await anonymizeBuyerPayments(userId);
  GdprLogger.logPaymentAction('anonymize_payment_data', { count }, userId);
  return count;
}

/** Anonymise les paiements sortis de la durée de conservation (action admin). */
export async function anonymizeExpiredPaymentsByAdmin(adminId: string): Promise<number> {
  const count = await anonymizeExpiredPayments();

  // Log d'audit pour démontrer la conformité
  GdprLogger.logPaymentAction('anonymize_old_payments', {
    count,
    operationType: 'gdpr_data_retention_policy',
    retention_period: '3 years'
  }, adminId);

  return count;
}
