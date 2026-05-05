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
   * Capture un paiement avec le compte vendeur connecté.
   * Tente la capture directement (sans vérifier le statut avant).
   * Si PayPal refuse, retry jusqu'à 5 fois avec délai.
   */
  static async captureConnectedPayment(orderId: string, sellerId: string): Promise<any> {
    try {
      const accessToken = await PayPalClient.getAccessToken();

      // Vérifier si déjà capturé
      const currentStatus = await PayPalClient.checkPaymentStatus(orderId);
      if (currentStatus === 'COMPLETED') {
        const orderDetails = await axios({
          method: 'get',
          url: `${paypalApiBaseUrl}/v2/checkout/orders/${orderId}`,
          headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        const captureInfo = orderDetails.data.purchase_units[0]?.payments?.captures[0];
        if (captureInfo) {
          return {
            status: 'COMPLETED',
            captureId: captureInfo.id,
            amount: captureInfo.amount.value,
            currency: captureInfo.amount.currency_code
          };
        }
      }

      // Récupérer l'email PayPal du vendeur pour le header Auth-Assertion
      const seller = await User.findById(sellerId).select('paypalEmail');
      const baseHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      };

      // Ajouter le PayPal-Auth-Assertion si le vendeur a un email PayPal
      let useAuthAssertion = false;
      if (seller?.paypalEmail) {
        const clientId = process.env.PAYPAL_CLIENT_ID;
        const headerPart1 = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64');
        const headerPart2 = Buffer.from(JSON.stringify({ iss: clientId, email: seller.paypalEmail })).toString('base64');
        baseHeaders['PayPal-Auth-Assertion'] = `${headerPart1}.${headerPart2}.`;
        useAuthAssertion = true;
      }

      // Tenter la capture directement avec retry
      let response;
      let lastError: any = null;

      for (let attempt = 1; attempt <= 5; attempt++) {
        const headers = {
          ...baseHeaders,
          'PayPal-Request-Id': `capture_${orderId}_${Date.now()}_${attempt}`
        };

        try {
          response = await axios({
            method: 'post',
            url: `${paypalApiBaseUrl}/v2/checkout/orders/${orderId}/capture`,
            headers
          });
          break; // Succès, sortir de la boucle
        } catch (err: any) {
          const status = err.response?.status;
          const details = err.response?.data;
          const issue = details?.details?.[0]?.issue || '';

          logger.warn(`Capture attempt ${attempt}/5 failed`, {
            orderId, status, issue,
            details: JSON.stringify(details)
          });

          // Si 403/400 avec Auth-Assertion, retirer et réessayer immédiatement
          if ((status === 403 || status === 400) && useAuthAssertion && baseHeaders['PayPal-Auth-Assertion']) {
            logger.warn('Retrait du PayPal-Auth-Assertion et retry', { orderId });
            delete baseHeaders['PayPal-Auth-Assertion'];
            useAuthAssertion = false;
            try {
              response = await axios({
                method: 'post',
                url: `${paypalApiBaseUrl}/v2/checkout/orders/${orderId}/capture`,
                headers: { ...baseHeaders, 'PayPal-Request-Id': `capture_${orderId}_${Date.now()}_${attempt}b` }
              });
              break;
            } catch (retryErr: any) {
              lastError = retryErr;
              const retryStatus = retryErr.response?.status;
              const retryIssue = retryErr.response?.data?.details?.[0]?.issue || '';
              if ((retryStatus === 422 || retryStatus === 400) &&
                  (retryIssue === 'ORDER_NOT_APPROVED' || retryIssue === 'INVALID_RESOURCE_ID')) {
                if (attempt < 5) {
                  await new Promise(resolve => setTimeout(resolve, 2000));
                  continue;
                }
              }
              throw retryErr;
            }
          }

          // Si ORDER_NOT_APPROVED (422) — PayPal n'a pas encore mis à jour le statut, on attend
          if ((status === 422 || status === 400) &&
              (issue === 'ORDER_NOT_APPROVED' || issue === 'ORDER_ALREADY_CAPTURED')) {
            if (issue === 'ORDER_ALREADY_CAPTURED') {
              // Déjà capturé, récupérer les détails
              const orderDetails = await axios({
                method: 'get',
                url: `${paypalApiBaseUrl}/v2/checkout/orders/${orderId}`,
                headers: { 'Authorization': `Bearer ${accessToken}` }
              });
              const captureInfo = orderDetails.data.purchase_units[0]?.payments?.captures[0];
              if (captureInfo) {
                return {
                  status: 'COMPLETED',
                  captureId: captureInfo.id,
                  amount: captureInfo.amount.value,
                  currency: captureInfo.amount.currency_code
                };
              }
            }
            lastError = err;
            if (attempt < 5) {
              logger.info(`Attente 2s avant retry capture (attempt ${attempt}/5)`, { orderId });
              await new Promise(resolve => setTimeout(resolve, 2000));
              continue;
            }
          }

          lastError = err;
          // Autre erreur non-retryable
          if (status !== 422 && status !== 400) {
            throw err;
          }
          if (attempt < 5) {
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        }
      }

      if (!response) {
        const errorDetails = lastError?.response?.data;
        const issue = errorDetails?.details?.[0]?.issue || 'UNKNOWN';
        throw new Error(`Impossible de capturer le paiement après 5 tentatives (dernier statut: ${issue}). L'acheteur doit d'abord valider le paiement sur PayPal.`);
      }

      if (response.data.status !== 'COMPLETED') {
        throw new Error(`La capture a échoué avec le statut: ${response.data.status}`);
      }

      const captureInfo = response.data.purchase_units[0]?.payments?.captures[0];
      if (!captureInfo) {
        throw new Error('Informations de capture introuvables dans la réponse PayPal');
      }

      return {
        status: response.data.status,
        captureId: captureInfo.id,
        amount: captureInfo.amount.value,
        currency: captureInfo.amount.currency_code
      };
    } catch (error) {
      logger.error('Erreur lors de la capture du paiement', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        orderId,
        sellerId: sellerId.substring(0, 5) + '...'
      });

      throw error;
    }
  }

  /**
   * Capture un paiement approuvé (méthode alternative — non utilisée par les controllers actuels)
   */
  static async capturePayment(orderId: string): Promise<any> {
    try {
      const accessToken = await PayPalClient.getAccessToken();

      const requestId = `capture_${orderId}_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;

      logger.debug('Tentative de capture d\'un paiement', {
        orderId: orderId.substring(0, 5) + '...',
        requestId
      });

      const response = await axios({
        method: 'post',
        url: `${paypalApiBaseUrl}/v2/checkout/orders/${orderId}/capture`,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          'PayPal-Request-Id': requestId,
          'Prefer': 'return=representation'
        }
      });

      if (response.data.status !== 'COMPLETED') {
        throw new Error(`La capture a échoué avec le statut: ${response.data.status}`);
      }

      logger.info('Paiement capturé avec succès', {
        orderId: orderId.substring(0, 5) + '...',
        status: response.data.status
      });

      const captureInfo = response.data.purchase_units[0]?.payments?.captures[0];
      if (!captureInfo) {
        throw new Error('Informations de capture introuvables dans la réponse PayPal');
      }

      return {
        status: response.data.status,
        captureId: captureInfo.id,
        amount: captureInfo.amount.value,
        currency: captureInfo.amount.currency_code,
        createTime: captureInfo.create_time,
        updateTime: captureInfo.update_time,
        finalCapture: captureInfo.final_capture || true
      };
    } catch (error) {
      logger.error('Erreur lors de la capture du paiement', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        orderId: orderId.substring(0, 5) + '...'
      });

      throw error;
    }
  }
}
