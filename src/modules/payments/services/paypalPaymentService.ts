import axios from 'axios';
import Product from '../../../models/productModel';
import User from '../../../models/userModel';
import Payment from '../../../models/paymentModel';
import { PayPalClient, paypalApiBaseUrl, partnerHeaders, extractDebugId } from './paypalClient';
import { PayPalPartnerService, SELLER_BLOCK_MESSAGES } from './paypalPartnerService';
import { paymentConfig } from '../../../config/paymentConfig';
import logger from '../../../commons/utils/logger';
import { formatForPayPal } from '../../../commons/utils/moneyMath';
import { resolveCheckout, ShippingAddress } from './checkoutService';

export interface CheckoutInput {
  shippingMethod: unknown;
  shippingAddress?: unknown;
}

/** Erreur métier : le vendeur n'est pas en état d'encaisser. */
export class SellerNotReadyError extends Error {
  readonly code: string;

  constructor(reason: keyof typeof SELLER_BLOCK_MESSAGES) {
    super(SELLER_BLOCK_MESSAGES[reason]);
    this.name = 'SellerNotReadyError';
    this.code = reason;
  }
}

function buildPayPalShipping(address: ShippingAddress) {
  return {
    name: { full_name: address.recipientName },
    address: {
      address_line_1: address.streetLine1,
      address_line_2: address.streetLine2,
      admin_area_2: address.city,
      postal_code: address.postalCode,
      country_code: address.country
    }
  };
}

/**
 * Calcule la commission plateforme prélevée via `platform_fees`.
 * Renvoie 0 si aucune commission n'est configurée (cas de la beta).
 */
function computePlatformFee(productAmount: number): number {
  const percent = paymentConfig.paypal.platformFeePercent;
  if (!Number.isFinite(percent) || percent <= 0) {
    return 0;
  }
  return Math.round(productAmount * percent) / 100;
}

/**
 * Flux de paiements PayPal Connected Path : création d'ordre, capture.
 *
 * L'ordre est créé par la plateforme (token API-caller) au bénéfice du vendeur
 * (`payee.merchant_id`). La capture s'appuie sur le header
 * `PayPal-Auth-Assertion` pour agir au nom du vendeur, sans jamais détenir
 * d'access token lui appartenant.
 */
export class PayPalPaymentService {
  /**
   * Crée un paiement direct pour un produit
   */
  static async createDirectPayment(
    productId: string,
    buyerId: string,
    checkout: CheckoutInput
  ): Promise<any> {
    try {
      const existingPayment = await Payment.findOne({
        product: productId,
        buyer: buyerId,
        status: 'pending'
      }).sort({ createdAt: -1 });

      if (existingPayment &&
        new Date().getTime() - new Date(existingPayment.createdAt).getTime() < 24 * 60 * 60 * 1000) {

        const paymentStatus = await PayPalClient.checkPaymentStatus(existingPayment.paymentIntentId);

        if (paymentStatus === 'CREATED' || paymentStatus === 'APPROVED') {
          const accessToken = await PayPalClient.getAccessToken();

          const response = await axios.get(
            `${paypalApiBaseUrl}/v2/checkout/orders/${existingPayment.paymentIntentId}`,
            { headers: partnerHeaders({ accessToken }) }
          );

          const approvalUrl = response.data.links.find(
            (link: any) => link.rel === 'approve'
          )?.href;

          return {
            orderId: existingPayment.paymentIntentId,
            approvalUrl,
            paymentId: existingPayment._id,
            amount: existingPayment.amount,
            currency: existingPayment.currency,
            resumed: true
          };
        }
      }

      const product = await Product.findById(productId);
      if (!product) {
        throw new Error('Produit non trouvé');
      }

      const seller = await User.findById(product.seller);
      if (!seller) {
        throw new Error('Vendeur non trouvé');
      }

      // L'IWT interdit de proposer PayPal pour un vendeur qui ne peut pas
      // encaisser : on bloque à la création de l'ordre plutôt que de laisser
      // l'acheteur découvrir l'échec au moment de payer.
      const blockReason = await PayPalPartnerService.assertSellerCanTransact(seller);
      if (blockReason) {
        throw new SellerNotReadyError(blockReason);
      }

      const buyer = await User.findById(buyerId).select('email');

      let priceToPay = product.price;

      if (product.negotiations && product.negotiations.length > 0) {
        const acceptedNegotiation = product.negotiations.find(
          (neg: any) => neg.buyer.toString() === buyerId && neg.status === 'accepted'
        );

        if (acceptedNegotiation) {
          priceToPay = acceptedNegotiation.counterOffer || acceptedNegotiation.currentOffer;
        }
      }

      const { method, breakdown, address } = resolveCheckout(
        product,
        priceToPay,
        checkout.shippingMethod,
        checkout.shippingAddress
      );
      const currency = product.currency || 'EUR';
      const platformFee = computePlatformFee(breakdown.productAmount);

      const accessToken = await PayPalClient.getAccessToken();

      const purchaseUnit: any = {
        amount: {
          currency_code: currency,
          value: formatForPayPal(breakdown.total),
          breakdown: {
            item_total: { currency_code: currency, value: formatForPayPal(breakdown.productAmount) },
            shipping: { currency_code: currency, value: formatForPayPal(breakdown.shippingAmount) }
          }
        },
        items: [{
          name: product.title.substring(0, 127),
          quantity: '1',
          unit_amount: { currency_code: currency, value: formatForPayPal(breakdown.productAmount) },
          category: 'PHYSICAL_GOODS'
        }],
        description: `Achat sur MyKpopTrade: ${product.title.substring(0, 100)}`,
        custom_id: productId,
        // Connected Path : le vendeur est désigné par son merchant ID PayPal,
        // pas par son email. C'est ce qui autorise la plateforme à encaisser
        // pour son compte sans détenir ses identifiants.
        payee: { merchant_id: seller.paypalMerchantId }
      };

      if (address) {
        purchaseUnit.shipping = buildPayPalShipping(address);
      }

      if (platformFee > 0) {
        purchaseUnit.payment_instruction = {
          disbursement_mode: 'INSTANT',
          platform_fees: [{
            amount: { currency_code: currency, value: formatForPayPal(platformFee) },
            payee: { merchant_id: paymentConfig.paypal.partnerMerchantId }
          }]
        };
      }

      const response = await axios.post(
        `${paypalApiBaseUrl}/v2/checkout/orders`,
        {
          intent: 'CAPTURE',
          purchase_units: [purchaseUnit],
          payment_source: {
            paypal: {
              // Prérempli la page de login PayPal côté acheteur (best practice
              // « Prefill » de l'IWT).
              email_address: buyer?.email,
              experience_context: {
                return_url: `${process.env.FRONTEND_URL}/payment/success?source=paypal`,
                cancel_url: `${process.env.FRONTEND_URL}/payment/cancel?source=paypal`,
                brand_name: 'MyKpopTrade',
                shipping_preference: address ? 'SET_PROVIDED_ADDRESS' : 'NO_SHIPPING',
                user_action: 'PAY_NOW',
                locale: 'fr-FR'
              }
            }
          }
        },
        {
          headers: partnerHeaders({
            accessToken,
            requestId: `order_${productId}_${buyerId}_${Date.now()}`
          })
        }
      );

      const approvalUrl = response.data.links.find(
        (link: any) => link.rel === 'payer-action' || link.rel === 'approve'
      )?.href;

      const payment = new Payment({
        product: productId,
        buyer: buyerId,
        seller: product.seller,
        amount: breakdown.total,
        productAmount: breakdown.productAmount,
        shippingAmount: breakdown.shippingAmount,
        shippingMethod: method,
        shippingAddress: address,
        platformFee,
        currency,
        paymentIntentId: response.data.id,
        approvalUrl,
        status: 'pending',
        paymentMethod: 'paypal',
        paymentType: 'direct'
      });

      await payment.save();

      await Product.findByIdAndUpdate(productId, {
        isReserved: true,
        reservedFor: buyerId,
        reservedUntil: new Date(Date.now() + 60 * 60 * 1000)
      });

      return {
        orderId: response.data.id,
        approvalUrl,
        paymentId: payment._id,
        amount: breakdown.total,
        productAmount: breakdown.productAmount,
        shippingAmount: breakdown.shippingAmount,
        shippingMethod: method,
        currency
      };
    } catch (error) {
      logger.error('Erreur lors de la création du paiement PayPal', {
        error: error instanceof Error ? error.message : String(error),
        productId,
        debugId: extractDebugId(error)
      });
      throw error;
    }
  }

  /**
   * Capture un paiement approuvé au nom du vendeur.
   *
   * Utilise le token **plateforme** seul, sans `PayPal-Auth-Assertion`.
   *
   * ⚠️ Ne pas ajouter l'auth assertion ici. L'ordre désigne déjà son vendeur via
   * `payee.merchant_id` ; PayPal considère ces deux mécanismes comme exclusifs
   * (« either through payee or through the PayPal-Auth-Assertion header ») et
   * répond 404 INVALID_RESOURCE_ID si les deux sont présents. Le remboursement,
   * lui, l'exige — une capture ne porte pas de `payee` (cf. paypalRefundService).
   *
   * Retry sur `ORDER_NOT_APPROVED` (l'acheteur vient d'approuver, PayPal peut
   * mettre quelques secondes à propager le statut).
   */
  static async captureConnectedPayment(
    orderId: string,
    sellerId: string
  ): Promise<{
    status: string;
    captureId: string;
    amount: string;
    currency: string;
  }> {
    const seller = await User.findById(sellerId).select('paypalMerchantId');
    if (!seller?.paypalMerchantId) {
      throw new Error(
        'Le vendeur n\'a pas de compte PayPal connecté. Il doit terminer son inscription PayPal avant que ce paiement puisse être capturé.'
      );
    }

    const accessToken = await PayPalClient.getAccessToken();
    const captureUrl = `${paypalApiBaseUrl}/v2/checkout/orders/${orderId}/capture`;
    const orderUrl = `${paypalApiBaseUrl}/v2/checkout/orders/${orderId}`;

    const fetchExistingCapture = async () => {
      const orderDetails = await axios.get(orderUrl, {
        headers: partnerHeaders({ accessToken })
      });
      const captureInfo = orderDetails.data.purchase_units[0]?.payments?.captures?.[0];
      if (!captureInfo) return null;
      return {
        status: 'COMPLETED',
        captureId: captureInfo.id,
        amount: captureInfo.amount.value,
        currency: captureInfo.amount.currency_code
      };
    };

    const currentStatus = await PayPalClient.checkPaymentStatus(orderId);
    if (currentStatus === 'COMPLETED') {
      const existing = await fetchExistingCapture();
      if (existing) return existing;
    }

    const MAX_ATTEMPTS = 5;
    const RETRY_DELAY_MS = 2000;
    let lastIssue = 'UNKNOWN';

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const response = await axios.post(captureUrl, undefined, {
          headers: partnerHeaders({
            accessToken,
            // Même clé d'idempotence sur toutes les tentatives : si PayPal a
            // déjà encaissé mais que la réponse s'est perdue, le retry renvoie
            // la capture existante au lieu d'en créer une seconde.
            requestId: `capture_${orderId}`
          })
        });

        if (response.data.status !== 'COMPLETED') {
          throw new Error(`La capture a échoué avec le statut: ${response.data.status}`);
        }

        const captureInfo = response.data.purchase_units[0]?.payments?.captures?.[0];
        if (!captureInfo) {
          throw new Error('Informations de capture introuvables dans la réponse PayPal');
        }

        return {
          status: response.data.status,
          captureId: captureInfo.id,
          amount: captureInfo.amount.value,
          currency: captureInfo.amount.currency_code
        };
      } catch (err: any) {
        const status = err.response?.status;
        const issue = err.response?.data?.details?.[0]?.issue || '';
        lastIssue = issue || lastIssue;

        if (issue === 'ORDER_ALREADY_CAPTURED') {
          const existing = await fetchExistingCapture();
          if (existing) return existing;
        }

        const isRetryable = (status === 422 || status === 400) && issue === 'ORDER_NOT_APPROVED';
        if (!isRetryable || attempt === MAX_ATTEMPTS) {
          logger.error('Erreur lors de la capture du paiement', {
            orderId,
            status,
            issue,
            attempt,
            error: err.response?.data?.message || err.message,
            debugId: extractDebugId(err)
          });
          throw err;
        }

        logger.info(`Capture en attente d'approbation, retry dans ${RETRY_DELAY_MS}ms`, {
          orderId,
          attempt: `${attempt}/${MAX_ATTEMPTS}`
        });
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }
    }

    throw new Error(
      `Impossible de capturer le paiement après ${MAX_ATTEMPTS} tentatives (${lastIssue}). L'acheteur doit valider le paiement sur PayPal.`
    );
  }
}
