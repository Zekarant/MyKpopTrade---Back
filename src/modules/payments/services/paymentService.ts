import { PayPalService } from './paypalService';
import { PayPalRefundError } from './paypalRefundService';
import Payment from '../../../models/paymentModel';
import Product from '../../../models/productModel';
import User from '../../../models/userModel';
import { EncryptionService } from '../../../commons/utils/encryptionService';
import { NotificationService } from '../../notifications/services/notificationService';
import { GdprLogger } from '../../../commons/utils/gdprLogger';
import { HttpError } from '../../../commons/utils/httpError';
import logger from '../../../commons/utils/logger';
import { gt, subtract } from '../../../commons/utils/moneyMath';
import { recordAuditLog } from '../../../commons/utils/auditService';

const PAYMENT_STATUS = {
  PENDING: 'pending',
  COMPLETED: 'completed'
} as const;

const PAYPAL_STATUS = {
  APPROVED: 'APPROVED',
  COMPLETED: 'COMPLETED'
} as const;

const ERROR_CODES = {
  SELLER_UNAVAILABLE: 'SELLER_UNAVAILABLE',
  PAYMENT_ACCESS_DENIED: 'PAYMENT_ACCESS_DENIED',
  REFUND_PERMISSION_DENIED: 'REFUND_PERMISSION_DENIED'
} as const;

const USER_ID_LOG_PREFIX_LENGTH = 5;

async function isUserAdmin(userId: string): Promise<boolean> {
  const user = await User.findById(userId).select('role');
  return Boolean(user && user.role === 'admin');
}

async function assertPaymentAccess(
  payment: any,
  userId: string,
  paymentId: string,
  buyerIdAccessor: (p: any) => string,
  sellerIdAccessor: (p: any) => string
): Promise<void> {
  const buyerId = buyerIdAccessor(payment);
  const sellerId = sellerIdAccessor(payment);

  if (buyerId === userId || sellerId === userId) {
    return;
  }

  if (await isUserAdmin(userId)) {
    return;
  }

  GdprLogger.logPaymentAction('unauthorized_access_attempt', {
    paymentId,
    targetPaymentBuyer: buyerId,
    targetPaymentSeller: sellerId
  }, userId);

  throw new HttpError(
    403,
    'Vous n\'êtes pas autorisé à accéder à ce paiement',
    ERROR_CODES.PAYMENT_ACCESS_DENIED
  );
}

async function markProductAsSold(productId: any, buyerId: any): Promise<void> {
  await Product.findByIdAndUpdate(productId, {
    isAvailable: false,
    isSold: true,
    soldAt: new Date(),
    soldTo: buyerId
  });
}

function decryptPaymentMetadata(paymentObj: any, paymentId: any): void {
  if (!paymentObj.paymentMetadata) return;

  try {
    paymentObj.metadata = JSON.parse(EncryptionService.decrypt(paymentObj.paymentMetadata));
    delete paymentObj.paymentMetadata;
  } catch (error) {
    logger.warn('Erreur lors du déchiffrement des métadonnées', {
      error: error instanceof Error ? error.message : String(error),
      paymentId
    });
  }
}

export async function buildConnectUrl(userId: string): Promise<string> {
  const seller = await User.findById(userId);
  if (!seller) {
    throw new HttpError(404, 'Utilisateur non trouvé');
  }

  return PayPalService.generateConnectUrl(userId);
}

export async function getPayPalConnectionStatus(userId: string): Promise<{
  connected: boolean;
  oauthConnected: boolean;
  expiresAt: Date | null;
  email: string | null;
}> {
  const user = await User.findById(userId).select('paypalConnected paypalEmail paypalTokens.expiresAt +paypalTokens.accessToken +paypalTokens.refreshToken');

  if (!user) {
    throw new HttpError(404, 'Utilisateur non trouvé');
  }

  const hasOAuthTokens = Boolean(
    user.paypalTokens?.accessToken &&
    user.paypalTokens?.refreshToken
  );

  const hasManualEmail = Boolean(user.paypalEmail);

  return {
    connected: Boolean(user.paypalConnected && (hasOAuthTokens || hasManualEmail)),
    oauthConnected: hasOAuthTokens,
    expiresAt: user.paypalTokens?.expiresAt || null,
    email: user.paypalEmail || null
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

export interface InitiateDirectPaymentInput {
  shippingMethod: unknown;
  shippingAddress?: unknown;
}

/**
 * Annule un paiement PayPal en attente et libère la réservation du produit.
 */
export async function cancelDirectPayment(userId: string, orderId: string) {
  if (!orderId) {
    throw new HttpError(400, 'ID de commande PayPal requis');
  }

  const payment = await Payment.findOne({
    paymentIntentId: orderId,
    buyer: userId,
    status: PAYMENT_STATUS.PENDING
  });

  if (!payment) {
    throw new HttpError(404, 'Paiement non trouvé ou déjà traité');
  }

  // Libérer la réservation du produit seulement si c'est bien cet acheteur qui l'a réservé
  await Product.findOneAndUpdate(
    {
      _id: payment.product,
      isReserved: true,
      reservedFor: userId
    },
    {
      isReserved: false,
      reservedFor: null,
      reservedUntil: null
    }
  );

  // Marquer le paiement comme annulé
  payment.status = 'cancelled' as any;
  await payment.save();

  logger.info('Paiement annulé et réservation libérée', {
    orderId,
    productId: payment.product,
    userId: userId.substring(0, USER_ID_LOG_PREFIX_LENGTH) + '...'
  });

  return { cancelled: true };
}

export async function initiateDirectPayment(
  userId: string,
  productId: string,
  checkout: InitiateDirectPaymentInput
) {
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

  return await PayPalService.createDirectPayment(productId, userId, checkout);
}

export async function captureDirectPayment(userId: string, orderId: string) {
  if (!orderId) {
    throw new HttpError(400, 'ID de commande PayPal requis');
  }

  const payment = await Payment.findOne({
    paymentIntentId: orderId,
    buyer: userId,
    status: PAYMENT_STATUS.PENDING
  });

  if (!payment) {
    throw new HttpError(404, 'Paiement non trouvé ou déjà traité');
  }

  const seller = await User.findById(payment.seller);
  if (!seller || !seller.paypalConnected) {
    throw new HttpError(
      400,
      'Vendeur non disponible ou non connecté à PayPal',
      ERROR_CODES.SELLER_UNAVAILABLE
    );
  }

  const captureResult = await PayPalService.captureConnectedPayment(
    orderId,
    payment.seller.toString()
  );

  payment.status = PAYMENT_STATUS.COMPLETED;
  payment.completedAt = new Date();
  payment.captureId = captureResult.captureId;
  await payment.save();

  await markProductAsSold(payment.product, payment.buyer);

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
    status: PAYMENT_STATUS.COMPLETED,
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

  if (paymentStatus === PAYPAL_STATUS.APPROVED) {
    return { kind: 'approved', orderId: orderId as string, paymentId: payment._id };
  }

  if (paymentStatus === PAYPAL_STATUS.COMPLETED) {
    if (payment.status !== PAYMENT_STATUS.COMPLETED) {
      payment.status = PAYMENT_STATUS.COMPLETED;
      payment.completedAt = new Date();
      await payment.save();

      await markProductAsSold(payment.product, payment.buyer);
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

  await assertPaymentAccess(
    payment,
    userId,
    paymentId,
    (p) => p.buyer.toString(),
    (p) => p.seller.toString()
  );

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
    decryptPaymentMetadata(paymentObj, payment._id);
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
  reason,
  password
}: {
  userId: string;
  paymentId: string;
  amount?: unknown;
  reason?: string;
  password?: string;
}) {
  const payment = await Payment.findById(paymentId);

  if (!payment) {
    throw new HttpError(404, 'Paiement non trouvé');
  }

  const isSeller = payment.seller.toString() === userId;
  const isAdmin = await isUserAdmin(userId);
  if (!isSeller && !isAdmin) {
    GdprLogger.logPaymentAction('unauthorized_refund_attempt', {
      paymentId,
      targetPaymentSeller: payment.seller.toString()
    }, userId);

    throw new HttpError(
      403,
      'Seul le vendeur ou un administrateur peut effectuer un remboursement',
      ERROR_CODES.REFUND_PERMISSION_DENIED
    );
  }

  if (
    payment.status !== PAYMENT_STATUS.COMPLETED &&
    payment.status !== 'partially_refunded'
  ) {
    throw new HttpError(400, 'Seul un paiement complété (ou partiellement remboursé) peut être remboursé');
  }

  if (!payment.captureId) {
    throw new HttpError(400, 'Ce paiement ne contient pas de capture PayPal à rembourser');
  }

  // Confirmation par mot de passe (le front la demande déjà ; on la valide).
  // Les admins en sont exemptés (ils interviennent en arbitrage, pas via UI vendeur).
  if (!isAdmin) {
    if (!password) {
      throw new HttpError(400, 'Mot de passe de confirmation requis');
    }
    const userWithPwd = await User.findById(userId).select('+password');
    if (!userWithPwd || !(await userWithPwd.comparePassword(password))) {
      GdprLogger.logPaymentAction('refund_password_invalid', { paymentId }, userId);
      throw new HttpError(401, 'Mot de passe incorrect');
    }
  }

  const alreadyRefunded = payment.totalRefunded || 0;
  const remaining = subtract(payment.amount, alreadyRefunded);

  if (gt(0.01, remaining)) {
    throw new HttpError(400, 'Ce paiement a déjà été entièrement remboursé');
  }

  let refundAmount: number | null;
  if (amount === undefined || amount === null || amount === '') {
    refundAmount = null;
  } else {
    const parsed = typeof amount === 'number' ? amount : parseFloat(String(amount));
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new HttpError(400, 'Le montant du remboursement doit être un nombre strictement positif');
    }
    if (gt(parsed, remaining)) {
      throw new HttpError(
        400,
        `Le montant demandé (${parsed} ${payment.currency}) dépasse le restant remboursable (${remaining} ${payment.currency})`
      );
    }
    refundAmount = parsed;
  }

  try {
    const refundResult = await PayPalService.refundConnectedPayment(
      payment.captureId,
      refundAmount,
      reason || '',
      payment.seller.toString()
    );

    // Persistance immédiate (statut 'pending') — le webhook PAYMENT.CAPTURE.REFUNDED
    // basculera l'entrée en 'completed' et mettra à jour totalRefunded/status.
    // En cas de webhook manqué, l'opération reste tracée.
    payment.refunds = payment.refunds || [];
    payment.refunds.push({
      refundId: refundResult.id,
      amount: refundAmount !== null ? refundAmount : remaining,
      currency: payment.currency,
      reason: reason || undefined,
      status: refundResult.status === 'COMPLETED' ? 'completed' : 'pending',
      initiatedBy: new (require('mongoose').Types.ObjectId)(userId),
      initiatedAt: new Date()
    });
    await payment.save();

    GdprLogger.logPaymentAction('refund_initiated', {
      paymentId,
      refundId: refundResult.id,
      isPartial: refundAmount !== null,
      amount: refundAmount,
      remaining: subtract(remaining, refundAmount !== null ? refundAmount : remaining)
    }, userId);

    if (isAdmin) {
      await recordAuditLog({
        adminId: userId,
        action: refundAmount === null ? 'refund_full' : 'refund_partial',
        targetType: 'payment',
        targetId: payment._id as any,
        details: reason || undefined,
        metadata: {
          refundId: refundResult.id,
          amount: refundAmount,
          currency: payment.currency
        }
      });
    }

    return {
      refundId: refundResult.id,
      status: refundResult.status,
      amount: refundAmount !== null ? refundAmount : remaining,
      currency: payment.currency,
      remaining: subtract(remaining, refundAmount !== null ? refundAmount : remaining),
      createdAt: refundResult.createdAt
    };
  } catch (error: any) {
    logger.error('Erreur lors du remboursement PayPal', {
      error: error instanceof Error ? error.message : String(error),
      paymentId,
      userId: userId.substring(0, USER_ID_LOG_PREFIX_LENGTH) + '...'
    });

    if (error instanceof PayPalRefundError) {
      const httpStatus = error.kind === 'auth' ? 401 : 400;
      const code = error.kind === 'auth' ? 'RECONNECT_PAYPAL' : undefined;
      throw new HttpError(httpStatus, error.message, code);
    }
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

  await assertPaymentAccess(
    payment,
    userId,
    paymentId,
    (p) => p.buyer._id.toString(),
    (p) => p.seller._id.toString()
  );

  GdprLogger.logPaymentAction('payment_details_accessed', { paymentId }, userId);

  return payment;
}

