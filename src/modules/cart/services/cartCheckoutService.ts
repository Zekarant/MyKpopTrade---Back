import { Types } from 'mongoose';
import { removePurchasedItems, validateCart } from './cartService';
import User from '../../../models/userModel';
import { PayPalService } from '../../payments/services/paypalService';
import { cancelDirectPayment } from '../../payments/services/paymentService';
import { HttpError } from '../../../commons/utils/httpError';
import logger from '../../../commons/utils/logger';

export interface CartCheckoutInput {
  shippingMethod: 'national' | 'worldwide' | 'localPickup';
  shippingAddress?: {
    recipientName: string;
    streetLine1: string;
    streetLine2?: string;
    postalCode: string;
    city: string;
    country?: string;
    phone?: string;
  };
}

interface SellerPaymentResult {
  sellerId: string;
  sellerUsername: string;
  paymentId: Types.ObjectId;
  /** Ordre PayPal : l'identifiant qu'attendent /payments/paypal/capture et /cancel. */
  paypalOrderId: string;
  approvalUrl?: string;
  amount: number;
  currency: string;
  productIds: string[];
}

type CartProduct = { _id: { toString(): string }; title?: string; seller: { toString(): string } };

/**
 * Checkout multi-seller : groupe les items du panier par vendeur,
 * crée un paiement PayPal par produit, et renvoie les URLs d'approbation.
 *
 * Tout ou rien : chaque paiement réserve son produit, donc les vendeurs sont
 * tous vérifiés avant le premier paiement et un échec annule ceux déjà créés.
 */
export async function checkoutCart(
  userId: string,
  checkout: CartCheckoutInput
): Promise<SellerPaymentResult[]> {
  // 1. Valider le panier
  const validation = await validateCart(userId);
  if (!validation.valid) {
    throw new HttpError(400, `Panier invalide : ${validation.issues.join(', ')}`);
  }

  // 2. Grouper les produits par vendeur
  const sellerGroups = new Map<string, CartProduct[]>();
  for (const item of validation.validItems) {
    // validateCart n'a retenu que des articles dont le produit existe encore.
    const product: CartProduct = item.product!;
    const sellerId = product.seller.toString();
    sellerGroups.set(sellerId, [...(sellerGroups.get(sellerId) ?? []), product]);
  }

  // 3. Tous les vendeurs doivent être reliés à PayPal, avant tout paiement.
  const sellers = await User.find({ _id: { $in: [...sellerGroups.keys()] } })
    .select('username paypalConnected paypalMerchantId');
  const sellerById = new Map(sellers.map((seller) => [seller._id.toString(), seller]));
  const unpayable = [...sellerGroups]
    .filter(([sellerId]) => {
      const seller = sellerById.get(sellerId);
      return !seller?.paypalMerchantId || !seller.paypalConnected;
    })
    .flatMap(([, products]) => products.map((product) => product.title || 'Produit inconnu'));
  if (unpayable.length) {
    throw new HttpError(
      400,
      `Le vendeur de "${unpayable.join(', ')}" n'est pas connecté à PayPal. Retirez ces articles du panier.`
    );
  }

  // 4. Un paiement par produit (PayPal ne répartit pas simplement un ordre
  // multi-produits vers un même vendeur). Le montant, négociation acceptée
  // comprise, vient de createDirectPayment (resolveBuyerPrice), comme le
  // `buyerPrice` affiché par le panier.
  const results: SellerPaymentResult[] = [];
  const createdOrderIds: string[] = [];

  for (const [sellerId, products] of sellerGroups) {
    const seller = sellerById.get(sellerId)!;
    for (const product of products) {
      const productId = product._id.toString();
      try {
        const paymentResult = await PayPalService.createDirectPayment(productId, userId, {
          shippingMethod: checkout.shippingMethod,
          shippingAddress: checkout.shippingAddress
        });
        if (!paymentResult.resumed) createdOrderIds.push(paymentResult.orderId);

        results.push({
          sellerId,
          sellerUsername: seller.username,
          paymentId: paymentResult.paymentId,
          paypalOrderId: paymentResult.orderId,
          approvalUrl: paymentResult.approvalUrl,
          amount: paymentResult.amount,
          currency: paymentResult.currency,
          productIds: [productId]
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : undefined;
        logger.error('Erreur lors de la création du paiement multi-seller', {
          error: message ?? String(error),
          sellerId,
          productId,
          userId
        });
        await cancelCreatedPayments(userId, createdOrderIds);
        throw new HttpError(
          400,
          message || `Erreur lors de la création du paiement pour le vendeur ${seller.username}`
        );
      }
    }
  }

  return results;
}

/** Annule les paiements créés par un checkout interrompu et libère leurs produits. */
async function cancelCreatedPayments(userId: string, orderIds: string[]): Promise<void> {
  for (const orderId of orderIds) {
    try {
      await cancelDirectPayment(userId, orderId);
    } catch (error) {
      logger.error('Annulation impossible après un checkout panier interrompu', {
        orderId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

/**
 * Appelé après chaque paiement capturé : retire du panier les articles payés.
 * Ne vide pas tout le panier, sinon annuler le 2e paiement d'un checkout
 * multi-vendeurs ferait perdre les articles non payés.
 */
export async function finalizeCartCheckout(userId: string): Promise<void> {
  await removePurchasedItems(userId);
}
