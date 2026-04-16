import { PayPalService } from './paypalService';
import Payment from '../../../models/paymentModel';
import Product from '../../../models/productModel';
import User from '../../../models/userModel';
import { EncryptionService } from '../../../commons/utils/encryptionService';
import { NotificationService } from '../../notifications/services/notificationService';
import { GdprLogger } from '../../../commons/utils/gdprLogger';
import { HttpError } from '../../../commons/utils/httpError';
import logger from '../../../commons/utils/logger';

export async function buildConnectUrl(userId: string): Promise<string> {
  const seller = await User.findById(userId);
  if (!seller) {
    throw new HttpError(404, 'Utilisateur non trouvé');
  }

  return PayPalService.generateConnectUrl(userId);
}

export async function getPayPalConnectionStatus(userId: string): Promise<{
  connected: boolean;
  expiresAt: Date | null;
}> {
  const user = await User.findById(userId).select('paypalConnected paypalTokens.expiresAt');

  if (!user) {
    throw new HttpError(404, 'Utilisateur non trouvé');
  }

  let tokensValid = false;
  if (user.paypalTokens && user.paypalTokens.expiresAt) {
    tokensValid = new Date(user.paypalTokens.expiresAt) > new Date();
  }

  return {
    connected: Boolean(user.paypalConnected && tokensValid),
    expiresAt: user.paypalTokens?.expiresAt || null
  };
}

export async function disconnectPayPalForUser(userId: string): Promise<void> {
  const user = await User.findByIdAndUpdate(userId, {
    paypalConnected: false,
    $unset: { paypalTokens: 1 }
  }, { new: true });

  if (!user) {
    throw new HttpError(404, 'Utilisateur non trouvé');
  }
}

export async function initiateDirectPayment(userId: string, productId: string) {
  if (!productId) {
    throw new HttpError(400, 'ID du produit requis');
  }

  const product = await Product.findOne({
    _id: productId,
    isSold: false,
    $or: [
      { isAvailable: true, isReserved: false },
      { isReserved: true, reservedFor: userId }
    ]
  });

  if (!product) {
    throw new HttpError(404, 'Produit non trouvé ou non disponible');
  }

  if (product.seller.toString() === userId) {
    throw new HttpError(400, 'Vous ne pouvez pas acheter votre propre produit');
  }

  return await PayPalService.createDirectPayment(productId, userId);
}

export async function captureDirectPayment(userId: string, orderId: string) {
  if (!orderId) {
    throw new HttpError(400, 'ID de commande PayPal requis');
  }

  const payment = await Payment.findOne({
    paymentIntentId: orderId,
    buyer: userId,
    status: 'pending'
  });

  if (!payment) {
    throw new HttpError(404, 'Paiement non trouvé ou déjà traité');
  }

  const seller = await User.findById(payment.seller);
  if (!seller || !seller.paypalConnected) {
    const err = new HttpError(400, 'Vendeur non disponible ou non connecté à PayPal');
    (err as any).code = 'SELLER_UNAVAILABLE';
    throw err;
  }

  const captureResult = await PayPalService.captureConnectedPayment(
    orderId,
    payment.seller.toString()
  );

  payment.status = 'completed';
  payment.completedAt = new Date();
  payment.captureId = captureResult.captureId;
  await payment.save();

  await Product.findByIdAndUpdate(payment.product, {
    isAvailable: false,
    isSold: true,
    soldAt: new Date(),
    soldTo: payment.buyer
  });

  await NotificationService.createNotification({
    recipientId: payment.seller,
    type: 'system',
    title: 'Nouveau paiement reçu',
    content: `Votre produit a été acheté pour ${payment.amount} ${payment.currency}.`,
    link: `/account/sales/${payment._id}`,
    data: {
      paymentId: payment._id,
      productId: payment.product,
      amount: payment.amount,
      currency: payment.currency
    }
  });

  return {
    id: payment._id,
    status: 'completed',
    captureId: captureResult.captureId,
    amount: captureResult.amount,
    currency: captureResult.currency
  };
}

export type ConfirmPaymentOutcome =
  | { kind: 'missing_order_id' }
  | { kind: 'payment_not_found' }
  | { kind: 'seller_unavailable' }
  | { kind: 'approved'; orderId: string; paymentId: any }
  | { kind: 'completed'; paymentId: any }
  | { kind: 'other'; orderId: string; status: string };

export async function resolveConfirmPayment(orderId: unknown): Promise<ConfirmPaymentOutcome> {
  if (!orderId) {
    return { kind: 'missing_order_id' };
  }

  const payment = await Payment.findOne({ paymentIntentId: orderId });
  if (!payment) {
    return { kind: 'payment_not_found' };
  }

  const seller = await User.findById(payment.seller);
  if (!seller) {
    return { kind: 'seller_unavailable' };
  }

  const paymentStatus = await PayPalService.checkPaymentStatus(orderId as string);

  if (paymentStatus === 'APPROVED') {
    return { kind: 'approved', orderId: orderId as string, paymentId: payment._id };
  }

  if (paymentStatus === 'COMPLETED') {
    if (payment.status !== 'completed') {
      payment.status = 'completed';
      payment.completedAt = new Date();
      await payment.save();

      await Product.findByIdAndUpdate(payment.product, {
        isAvailable: false,
        isSold: true,
        soldAt: new Date(),
        soldTo: payment.buyer
      });
    }
    return { kind: 'completed', paymentId: payment._id };
  }

  return { kind: 'other', orderId: orderId as string, status: paymentStatus };
}

export async function fetchPaymentStatus(userId: string, paymentId: string) {
  const payment = await Payment.findById(paymentId)
    .populate('product', 'title price images');

  if (!payment) {
    throw new HttpError(404, 'Paiement non trouvé');
  }

  const isAuthorized =
    payment.buyer.toString() === userId ||
    payment.seller.toString() === userId;

  if (!isAuthorized) {
    const user = await User.findById(userId).select('role');

    if (!user || user.role !== 'admin') {
      GdprLogger.logPaymentAction('unauthorized_access_attempt', {
        paymentId,
        targetPaymentBuyer: payment.buyer.toString(),
        targetPaymentSeller: payment.seller.toString()
      }, userId);

      const err = new HttpError(403, 'Vous n\'êtes pas autorisé à accéder à ce paiement');
      (err as any).code = 'PAYMENT_ACCESS_DENIED';
      throw err;
    }
  }

  GdprLogger.logPaymentAction('payment_status_checked', { paymentId }, userId);

  return {
    status: payment.status,
    payment
  };
}

export async function listUserPayments(
  userId: string,
  role: string,
  status: string | undefined,
  page: number,
  limit: number
) {
  const filter: any = {};

  if (role === 'buyer') {
    filter.buyer = userId;
  } else if (role === 'seller') {
    filter.seller = userId;
  } else {
    filter.$or = [{ buyer: userId }, { seller: userId }];
  }

  if (status) {
    filter.status = status;
  }

  const skip = (page - 1) * limit;

  const payments = await Payment.find(filter)
    .populate('product', 'title images price currency')
    .populate('buyer', 'username profilePicture')
    .populate('seller', 'username profilePicture')
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit);

  const total = await Payment.countDocuments(filter);

  const processedPayments = payments.map(payment => {
    const paymentObj = payment.toObject();

    delete paymentObj.ipAddress;
    delete paymentObj.userAgent;

    if (paymentObj.paymentMetadata) {
      try {
        (paymentObj as any).metadata = JSON.parse(EncryptionService.decrypt(paymentObj.paymentMetadata));
        delete paymentObj.paymentMetadata;
      } catch (error) {
        logger.warn('Erreur lors du déchiffrement des métadonnées', {
          error: error instanceof Error ? error.message : String(error),
          paymentId: payment._id
        });
      }
    }

    return paymentObj;
  });

  return {
    data: processedPayments,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit)
    }
  };
}

export async function processRefund({
  userId,
  paymentId,
  amount,
  reason
}: {
  userId: string;
  paymentId: string;
  amount?: unknown;
  reason?: string;
}) {
  const payment = await Payment.findById(paymentId);

  if (!payment) {
    throw new HttpError(404, 'Paiement non trouvé');
  }

  const isSeller = payment.seller.toString() === userId;
  let isAdmin = false;

  if (!isSeller) {
    const user = await User.findById(userId).select('role');
    isAdmin = Boolean(user && user.role === 'admin');

    if (!isAdmin) {
      GdprLogger.logPaymentAction('unauthorized_refund_attempt', {
        paymentId,
        targetPaymentSeller: payment.seller.toString()
      }, userId);

      const err = new HttpError(403, 'Seul le vendeur ou un administrateur peut effectuer un remboursement');
      (err as any).code = 'REFUND_PERMISSION_DENIED';
      throw err;
    }
  }

  if (payment.status !== 'completed') {
    throw new HttpError(400, 'Seul un paiement complété peut être remboursé');
  }

  if (!payment.captureId) {
    throw new HttpError(400, 'Ce paiement ne contient pas de capture PayPal à rembourser');
  }

  const refundAmount =
    amount === undefined || amount === null || amount === ''
      ? null
      : parseFloat(amount as string);

  try {
    const refundResult = await PayPalService.refundConnectedPayment(
      payment.captureId,
      refundAmount,
      reason || '',
      payment.seller.toString()
    );

    GdprLogger.logPaymentAction('refund_initiated', {
      paymentId,
      refundId: refundResult.id,
      isPartial: refundAmount !== null
    }, userId);

    return {
      refundId: refundResult.id,
      status: refundResult.status,
      amount: refundAmount,
      createdAt: refundResult.createdAt
    };
  } catch (error: any) {
    logger.error('Erreur lors du remboursement PayPal', {
      error: error instanceof Error ? error.message : String(error),
      paymentId,
      userId: userId.substring(0, 5) + '...'
    });
    throw new HttpError(400, error.message || 'Erreur lors du remboursement');
  }
}

export async function fetchPaymentDetails(userId: string, paymentId: string) {
  const payment = await Payment.findById(paymentId)
    .populate('product', 'title description price images')
    .populate('buyer', 'username email profileImage')
    .populate('seller', 'username email profileImage');

  if (!payment) {
    throw new HttpError(404, 'Paiement non trouvé');
  }

  const isAuthorized =
    payment.buyer._id.toString() === userId ||
    payment.seller._id.toString() === userId;

  if (!isAuthorized) {
    const user = await User.findById(userId).select('role');

    if (!user || user.role !== 'admin') {
      GdprLogger.logPaymentAction('unauthorized_access_attempt', {
        paymentId,
        targetPaymentBuyer: payment.buyer._id.toString(),
        targetPaymentSeller: payment.seller._id.toString()
      }, userId);

      const err = new HttpError(403, 'Vous n\'êtes pas autorisé à accéder à ce paiement');
      (err as any).code = 'PAYMENT_ACCESS_DENIED';
      throw err;
    }
  }

  GdprLogger.logPaymentAction('payment_details_accessed', { paymentId }, userId);

  return payment;
}
