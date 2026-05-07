import axios from 'axios';
import Product from '../../../models/productModel';
import User from '../../../models/userModel';
import Payment from '../../../models/paymentModel';
import { PayPalClient, paypalApiBaseUrl } from './paypalClient';
import logger from '../../../commons/utils/logger';
import { resolveCheckout, ShippingAddress } from './checkoutService';

export interface CheckoutInput {
  shippingMethod: unknown;
  shippingAddress?: unknown;
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
 * Flux de paiements PayPal : création d'ordre, capture.
 * Gère la logique métier (produit, négociation acceptée, réservation).
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

          const response = await axios({
            method: 'get',
            url: `${paypalApiBaseUrl}/v2/checkout/orders/${existingPayment.paymentIntentId}`,
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${accessToken}`
            }
          });

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

      if (!seller.paypalEmail) {
        throw new Error('Le vendeur n\'a pas configuré son email PayPal');
      }

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

      const accessToken = await PayPalClient.getAccessToken();

      const purchaseUnit: any = {
        amount: {
          currency_code: currency,
          value: breakdown.total.toFixed(2),
          breakdown: {
            item_total: { currency_code: currency, value: breakdown.productAmount.toFixed(2) },
            shipping: { currency_code: currency, value: breakdown.shippingAmount.toFixed(2) }
          }
        },
        items: [{
          name: product.title.substring(0, 127),
          quantity: '1',
          unit_amount: { currency_code: currency, value: breakdown.productAmount.toFixed(2) },
          category: 'PHYSICAL_GOODS'
        }],
        description: `Achat sur MyKpopTrade: ${product.title.substring(0, 100)}`,
        custom_id: productId,
        payee: { email_address: seller.paypalEmail }
      };

      if (address) {
        purchaseUnit.shipping = buildPayPalShipping(address);
      }

      const response = await axios({
        method: 'post',
        url: `${paypalApiBaseUrl}/v2/checkout/orders`,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`
        },
        data: {
          intent: 'CAPTURE',
          purchase_units: [purchaseUnit],
          application_context: {
            return_url: `${process.env.FRONTEND_URL}/payment/success?source=paypal`,
            cancel_url: `${process.env.FRONTEND_URL}/payment/cancel?source=paypal`,
            brand_name: 'MyKpopTrade',
            shipping_preference: address ? 'SET_PROVIDED_ADDRESS' : 'NO_SHIPPING',
            user_action: 'PAY_NOW',
            locale: 'fr-FR'
          }
        }
      });

      const approvalUrl = response.data.links.find(
        (link: any) => link.rel === 'approve'
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
        platformFee: 0,
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
        productId
      });
      throw error;
    }
  }

  /**
   * Capture un paiement approuvé.
   *
   * Utilise le token OAuth du **vendeur** (le `payee` de l'order). Sans
   * statut PayPal Partner, c'est le seul moyen pour la plateforme de
   * capturer un order au bénéfice d'un compte tiers : sinon PayPal
   * répond `PAYEE_NOT_CONSENTED`. Si le vendeur n'a plus de tokens OAuth
   * valides, la capture est impossible — il doit reconnecter PayPal.
   *
   * Retry sur `ORDER_NOT_APPROVED` (l'acheteur vient d'approuver, PayPal
   * peut mettre quelques secondes à propager le statut).
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
    const sellerAccessToken = await PayPalClient.getSellerAccessToken(sellerId);
    if (!sellerAccessToken) {
      throw new Error(
        'Le vendeur n\'a plus de connexion PayPal valide. Il doit se reconnecter avant que ce paiement puisse être capturé.'
      );
    }

    const captureUrl = `${paypalApiBaseUrl}/v2/checkout/orders/${orderId}/capture`;
    const orderUrl = `${paypalApiBaseUrl}/v2/checkout/orders/${orderId}`;

    const fetchExistingCapture = async () => {
      const orderDetails = await axios.get(orderUrl, {
        headers: { Authorization: `Bearer ${sellerAccessToken}` }
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
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${sellerAccessToken}`,
            'PayPal-Request-Id': `capture_${orderId}_${attempt}`
          }
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
            error: err.response?.data?.message || err.message
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
