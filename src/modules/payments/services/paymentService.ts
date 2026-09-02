import mongoose from 'mongoose';
import { PayPalService } from './paypalService';
import { PayPalRefundError } from './paypalRefundService';
import { applyRefundToPayment, notifyRefund, remainingRefundable } from './refundLedger';
import { SELLER_BLOCK_MESSAGES, SellerBlockReason } from './paypalPartnerService';
import { SellerNotReadyError } from './paypalPaymentService';
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

/**
 * Génère le lien d'inscription PayPal (Partner Referrals) pour un vendeur.
 */
export async function buildOnboardingLink(userId: string): Promise<string> {
  const seller = await User.findById(userId);
  if (!seller) {
    throw new HttpError(404, 'Utilisateur non trouvé');
  }

  return PayPalService.createOnboardingLink(userId);
}

export interface PayPalAccountStatus {
  connected: boolean;
  merchantId: string | null;
  email: string | null;
  /** Raison sociale du compte PayPal relié — PayPal n'expose pas l'email ici. */
  legalName: string | null;
  paymentsReceivable: boolean;
  primaryEmailConfirmed: boolean;
  consentGranted: boolean;
  scopes: string[];
  checkedAt: Date | null;
  /** Raison du blocage, `null` si le vendeur peut encaisser. */
  blockReason: SellerBlockReason | null;
  /** Message à afficher tel quel au vendeur, `null` si tout va bien. */
  blockMessage: string | null;
}

/**
 * Renvoie le statut d'onboarding PayPal d'un vendeur.
 *
 * L'IWT impose que le vendeur puisse consulter son statut, y compris son
 * merchant ID et les permissions accordées à la plateforme. `refresh` force un
 * appel « show seller status » — utilisé quand le vendeur clique explicitement
 * sur « rafraîchir » après avoir corrigé son compte chez PayPal.
 */
export async function getPayPalAccountStatus(
  userId: string,
  options: { refresh?: boolean } = {}
): Promise<PayPalAccountStatus> {
  const user = await User.findById(userId).select(
    'paypalConnected paypalEmail paypalMerchantId paypalOnboarding'
  );

  if (!user) {
    throw new HttpError(404, 'Utilisateur non trouvé');
  }

  if (!user.paypalMerchantId) {
    return {
      connected: false,
      merchantId: null,
      email: null,
      legalName: null,
      paymentsReceivable: false,
      primaryEmailConfirmed: false,
      consentGranted: false,
      scopes: [],
      checkedAt: null,
      blockReason: 'NOT_ONBOARDED',
      blockMessage: SELLER_BLOCK_MESSAGES.NOT_ONBOARDED
    };
  }

  if (options.refresh) {
    await PayPalService.refreshSellerStatus(userId);
  }

  const fresh = options.refresh
    ? await User.findById(userId).select('paypalConnected paypalEmail paypalMerchantId paypalOnboarding')
    : user;

  const onboarding = fresh?.paypalOnboarding || {};
  // `checkedAt` absent = le compte est relié mais PayPal n'a jamais répondu.
  // On le distingue d'un vrai refus, sinon on accuse le vendeur d'une
  // inscription incomplète alors que c'est notre appel qui a échoué.
  const blockReason: SellerBlockReason | null = !onboarding.checkedAt
    ? 'STATUS_UNKNOWN'
    : !onboarding.consentGranted
      ? 'CONSENT_MISSING'
      : !onboarding.primaryEmailConfirmed
        ? 'EMAIL_UNCONFIRMED'
        : !onboarding.paymentsReceivable
          ? 'PAYMENTS_NOT_RECEIVABLE'
          : null;

  return {
    connected: Boolean(fresh?.paypalConnected) && blockReason === null,
    merchantId: fresh?.paypalMerchantId || null,
    email: fresh?.paypalEmail || null,
    legalName: onboarding.legalName || null,
    paymentsReceivable: Boolean(onboarding.paymentsReceivable),
    primaryEmailConfirmed: Boolean(onboarding.primaryEmailConfirmed),
    consentGranted: Boolean(onboarding.consentGranted),
    scopes: onboarding.scopes || [],
    checkedAt: onboarding.checkedAt || null,
    blockReason,
    blockMessage: blockReason ? SELLER_BLOCK_MESSAGES[blockReason] : null
  };
}

/**
 * Délie le compte PayPal du vendeur.
 *
 * MyKpopTrade ne peut pas révoquer les permissions côté PayPal : on « oublie »
 * l'association pour que le vendeur puisse relier un autre compte.
 */
export async function disconnectPayPalForUser(userId: string): Promise<void> {
  const user = await User.findById(userId).select('_id');
  if (!user) {
    throw new HttpError(404, 'Utilisateur non trouvé');
  }

  await PayPalService.forgetSellerAccount(userId);
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

  try {
    return await PayPalService.createDirectPayment(productId, userId, checkout);
  } catch (error) {
    // Le vendeur n'est pas (ou plus) en état d'encaisser : c'est une erreur
    // métier attendue, pas un 500. Le front affiche le message tel quel.
    if (error instanceof SellerNotReadyError) {
      throw new HttpError(400, error.message, ERROR_CODES.SELLER_UNAVAILABLE);
    }
    throw error;
  }
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
  if (!seller?.paypalMerchantId) {
    throw new HttpError(
      400,
      'Le vendeur n\'a plus de compte PayPal relié : ce paiement ne peut pas être encaissé.',
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

  // Stripe a été retiré de la plateforme. Les paiements historiques encaissés par
  // ce canal restent lisibles, mais ne peuvent plus être remboursés depuis l'API :
  // le remboursement se fait alors depuis le tableau de bord Stripe du vendeur.
  if (payment.paymentMethod === 'stripe') {
    throw new HttpError(
      409,
      "Ce paiement a été encaissé via Stripe, qui n'est plus pris en charge. Le remboursement doit être effectué depuis votre tableau de bord Stripe."
    );
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

  // Calculé à partir de l'historique détaillé, pas du seul `totalRefunded` :
  // ce compteur n'était alimenté que par le webhook, si bien qu'un webhook
  // manquant rouvrait la totalité du montant à un second remboursement.
  const remaining = remainingRefundable(payment);

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

    // PayPal a confirmé : on applique tout de suite le montant qu'il a
    // réellement remboursé (il plafonne silencieusement une demande trop
    // élevée). Le webhook PAYMENT.CAPTURE.REFUNDED repassera sur la même
    // entrée sans rien doubler — mais l'état est correct sans lui.
    const ledger = applyRefundToPayment(payment, {
      refundId: refundResult.id,
      amount: refundResult.amount,
      currency: refundResult.currency,
      reason,
      initiatedBy: new mongoose.Types.ObjectId(userId)
    });
    await payment.save();

    if (ledger.isFullyRefunded) {
      await Product.findByIdAndUpdate(payment.product, {
        isAvailable: true,
        isSold: false,
        soldAt: null,
        soldTo: null
      });
    }

    await notifyRefund(payment, refundResult.amount, ledger);

    GdprLogger.logPaymentAction('refund_initiated', {
      paymentId,
      refundId: refundResult.id,
      isPartial: !ledger.isFullyRefunded,
      amount: refundResult.amount,
      remaining: subtract(remaining, refundResult.amount)
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
          amount: refundResult.amount,
          currency: payment.currency
        }
      });
    }

    return {
      refundId: refundResult.id,
      status: refundResult.status,
      amount: refundResult.amount,
      currency: refundResult.currency,
      remaining: subtract(remaining, refundResult.amount),
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

