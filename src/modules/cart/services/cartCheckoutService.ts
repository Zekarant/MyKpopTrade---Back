import { validateCart } from './cartService';
import { clearCart } from './cartService';
import Product from '../../../models/productModel';
import User from '../../../models/userModel';
import { PayPalService } from '../../payments/services/paypalService';
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
  paymentId: string;
  approvalUrl: string;
  amount: number;
  currency: string;
  productIds: string[];
}

/**
 * Checkout multi-seller : groupe les items du panier par vendeur,
 * crée un paiement PayPal par vendeur, et renvoie les URLs d'approbation.
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

  const { validItems } = validation;

  // 2. Grouper les items par vendeur
  const sellerGroups = new Map<string, typeof validItems>();
  for (const item of validItems) {
    const product = item.product as any;
    const sellerId = product.seller.toString();
    if (!sellerGroups.has(sellerId)) {
      sellerGroups.set(sellerId, []);
    }
    sellerGroups.get(sellerId)!.push(item);
  }

  // 3. Pour chaque vendeur, vérifier qu'il est connecté à PayPal et créer le paiement
  const results: SellerPaymentResult[] = [];

  for (const [sellerId, items] of sellerGroups) {
    const seller = await User.findById(sellerId).select('username paypalConnected paypalTokens');
    if (!seller || !seller.paypalConnected) {
      const productTitles = await Promise.all(
        items.map(async (item) => {
          const p = await Product.findById(item.product).select('title');
          return p?.title || 'Produit inconnu';
        })
      );
      throw new HttpError(
        400,
        `Le vendeur de "${productTitles.join(', ')}" n'est pas connecté à PayPal. Retirez ces articles du panier.`
      );
    }

    // On utilise le premier produit pour le paiement direct mais on passe tous les items
    // Pour simplifier, on fait un paiement par produit (PayPal ne supporte pas facilement le split dans un seul ordre pour multi-produits vers un même seller)
    for (const item of items) {
      const productId = (item.product as any)._id?.toString() || item.product.toString();

      try {
        const paymentResult = await PayPalService.createDirectPayment(productId, userId, {
          shippingMethod: checkout.shippingMethod,
          shippingAddress: checkout.shippingAddress
        });

        results.push({
          sellerId,
          sellerUsername: seller.username,
          paymentId: paymentResult.paymentId,
          approvalUrl: paymentResult.approvalUrl,
          amount: paymentResult.amount,
          currency: paymentResult.currency,
          productIds: [productId]
        });
      } catch (error: any) {
        logger.error('Erreur lors de la création du paiement multi-seller', {
          error: error.message,
          sellerId,
          productId,
          userId
        });
        throw new HttpError(
          400,
          error.message || `Erreur lors de la création du paiement pour le vendeur ${seller.username}`
        );
      }
    }
  }

  return results;
}

/**
 * Après que tous les paiements ont été approuvés et capturés, vider le panier.
 */
export async function finalizeCartCheckout(userId: string): Promise<void> {
  await clearCart(userId);
}
