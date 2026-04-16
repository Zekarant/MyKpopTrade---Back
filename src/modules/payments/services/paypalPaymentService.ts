import axios from 'axios';
import Product from '../../../models/productModel';
import User from '../../../models/userModel';
import Payment from '../../../models/paymentModel';
import { PayPalClient, paypalApiBaseUrl } from './paypalClient';
import logger from '../../../commons/utils/logger';

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
    buyerId: string
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

      let amountToPay = product.price;

      if (product.negotiations && product.negotiations.length > 0) {
        const acceptedNegotiation = product.negotiations.find(
          (neg: any) => neg.buyer.toString() === buyerId && neg.status === 'accepted'
        );

        if (acceptedNegotiation) {
          amountToPay = acceptedNegotiation.counterOffer || acceptedNegotiation.currentOffer;
        }
      }

      const roundedPrice = parseFloat(amountToPay.toFixed(2));

      const accessToken = await PayPalClient.getAccessToken();

      const response = await axios({
        method: 'post',
        url: `${paypalApiBaseUrl}/v2/checkout/orders`,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`
        },
        data: {
          intent: 'CAPTURE',
          purchase_units: [
            {
              amount: {
                currency_code: product.currency || 'EUR',
                value: roundedPrice.toString()
              },
              description: `Achat sur MyKpopTrade: ${product.title.substring(0, 100)}`,
              custom_id: productId,
              payee: {
                email_address: seller.paypalEmail
              }
            }
          ],
          application_context: {
            return_url: `${process.env.FRONTEND_URL}/payment/success?source=paypal`,
            cancel_url: `${process.env.FRONTEND_URL}/payment/cancel?source=paypal`,
            brand_name: 'MyKpopTrade',
            shipping_preference: 'NO_SHIPPING',
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
        amount: roundedPrice,
        platformFee: 0,
        currency: product.currency || 'EUR',
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
        amount: roundedPrice,
        currency: product.currency || 'EUR'
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
   * Capture un paiement avec le compte vendeur connecté
   */
  static async captureConnectedPayment(orderId: string, sellerId: string): Promise<any> {
    try {
      const accessToken = await PayPalClient.getAccessToken();

      const requestId = `capture_${orderId}_${Date.now()}`;

      const response = await axios({
        method: 'post',
        url: `${paypalApiBaseUrl}/v2/checkout/orders/${orderId}/capture`,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          'PayPal-Request-Id': requestId
        }
      });

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
