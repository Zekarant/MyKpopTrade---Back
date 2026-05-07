import Product from '../../../models/productModel';
import User from '../../../models/userModel';
import Payment from '../../../models/paymentModel';
import { HttpError } from '../../../commons/utils/httpError';
import logger from '../../../commons/utils/logger';
import { resolveCheckout } from './checkoutService';
import { getStripe, getPlatformFeePercent, toCents } from './stripeClient';

export interface InitStripeCheckoutInput {
  productId: string;
  buyerId: string;
  shippingMethod: unknown;
  shippingAddress?: unknown;
}

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:8080';

/**
 * Crée une Checkout Session Stripe avec Destination Charge :
 * l'argent est versé sur le compte connecté du vendeur, moins la commission
 * plateforme (`PLATFORM_FEE_PERCENT`). Stripe porte la liability — pas
 * d'agrément ACPR nécessaire pour la plateforme.
 */
export async function createStripeCheckoutSession(input: InitStripeCheckoutInput) {
  const { productId, buyerId, shippingMethod, shippingAddress } = input;

  const product = await Product.findOne({
    _id: productId,
    isSold: false,
    $or: [
      { isAvailable: true, isReserved: false },
      { isReserved: true, reservedFor: buyerId }
    ]
  });

  if (!product) {
    throw new HttpError(404, 'Produit non trouvé ou non disponible');
  }

  if (product.seller.toString() === buyerId) {
    throw new HttpError(400, 'Vous ne pouvez pas acheter votre propre produit');
  }

  const seller = await User.findById(product.seller);
  if (!seller) {
    throw new HttpError(400, 'Vendeur introuvable');
  }

  if (!seller.stripeAccountId || !seller.stripeChargesEnabled) {
    throw new HttpError(
      400,
      'Le vendeur n\'a pas activé les paiements Stripe',
      'SELLER_STRIPE_NOT_READY'
    );
  }

  let priceToPay = product.price;
  if (product.negotiations?.length) {
    const accepted = product.negotiations.find(
      (neg: any) => neg.buyer.toString() === buyerId && neg.status === 'accepted'
    );
    if (accepted) {
      priceToPay = accepted.counterOffer || accepted.currentOffer;
    }
  }

  const buyer = await User.findById(buyerId);
  if (!buyer) {
    throw new HttpError(404, 'Acheteur introuvable');
  }

  const { method, breakdown, address } = resolveCheckout(
    product,
    priceToPay,
    shippingMethod,
    shippingAddress
  );
  const currency = (product.currency || 'EUR').toLowerCase();

  const totalCents = toCents(breakdown.total);
  const productCents = toCents(breakdown.productAmount);
  const shippingCents = toCents(breakdown.shippingAmount);
  const platformFeeCents = Math.round((totalCents * getPlatformFeePercent()) / 100);

  const stripe = getStripe();

  const lineItems: any[] = [
    {
      price_data: {
        currency,
        unit_amount: productCents,
        product_data: {
          name: product.title.substring(0, 250),
          metadata: { product_id: String(product._id) }
        }
      },
      quantity: 1
    }
  ];

  if (shippingCents > 0) {
    lineItems.push({
      price_data: {
        currency,
        unit_amount: shippingCents,
        product_data: { name: 'Frais de livraison' }
      },
      quantity: 1
    });
  }

  const sessionParams: any = {
    mode: 'payment',
    payment_method_types: ['card'],
    customer_email: buyer.email,
    line_items: lineItems,
    payment_intent_data: {
      transfer_data: { destination: seller.stripeAccountId },
      metadata: {
        product_id: String(product._id),
        seller_id: String(seller._id),
        buyer_id: String(buyer._id)
      }
    },
    success_url: `${FRONTEND_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}&source=stripe`,
    cancel_url: `${FRONTEND_URL}/payment/cancel?source=stripe`,
    metadata: {
      product_id: String(product._id),
      seller_id: String(seller._id),
      buyer_id: String(buyer._id)
    }
  };

  if (platformFeeCents > 0) {
    sessionParams.payment_intent_data.application_fee_amount = platformFeeCents;
  }

  if (address) {
    sessionParams.shipping_address_collection = { allowed_countries: [address.country] };
  }

  const session = await stripe.checkout.sessions.create(sessionParams);

  const payment = new Payment({
    product: product._id,
    buyer: buyerId,
    seller: product.seller,
    amount: breakdown.total,
    productAmount: breakdown.productAmount,
    shippingAmount: breakdown.shippingAmount,
    shippingMethod: method,
    shippingAddress: address,
    platformFee: platformFeeCents > 0 ? platformFeeCents / 100 : 0,
    currency: currency.toUpperCase(),
    paymentIntentId: session.id,
    approvalUrl: session.url || undefined,
    status: 'pending',
    paymentMethod: 'stripe',
    paymentType: 'direct',
    stripeCheckoutSessionId: session.id,
    stripePaymentIntentId:
      typeof session.payment_intent === 'string' ? session.payment_intent : undefined,
    platformFeeCents
  });

  await payment.save();

  await Product.findByIdAndUpdate(productId, {
    isReserved: true,
    reservedFor: buyerId,
    reservedUntil: new Date(Date.now() + 60 * 60 * 1000)
  });

  logger.info('Stripe Checkout Session créée', {
    sessionId: session.id,
    paymentId: String(payment._id),
    sellerId: String(seller._id),
    totalCents,
    platformFeeCents
  });

  return {
    sessionId: session.id,
    checkoutUrl: session.url,
    paymentId: payment._id,
    amount: breakdown.total,
    productAmount: breakdown.productAmount,
    shippingAmount: breakdown.shippingAmount,
    shippingMethod: method,
    currency: currency.toUpperCase()
  };
}
