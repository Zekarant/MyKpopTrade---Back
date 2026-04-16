import axios from 'axios';
import logger from '../../../commons/utils/logger';

/**
 * URL de base de l'API PayPal (sandbox en non-production).
 */
export const paypalApiBaseUrl = process.env.NODE_ENV === 'production'
  ? 'https://api.paypal.com'
  : 'https://api.sandbox.paypal.com';

/**
 * Low-level PayPal API client : token, lecture d'ordres, détails de captures.
 * Ne contient aucune logique métier — uniquement des appels HTTP typés.
 */
export class PayPalClient {
  /**
   * Obtient un token d'accès pour l'API PayPal
   */
  static async getAccessToken(): Promise<string> {
    try {
      const clientId = process.env.PAYPAL_CLIENT_ID;
      const clientSecret = process.env.PAYPAL_CLIENT_SECRET;

      if (!clientId || !clientSecret) {
        throw new Error('Les identifiants PayPal ne sont pas configurés');
      }

      const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

      const response = await axios({
        method: 'post',
        url: `${paypalApiBaseUrl}/v1/oauth2/token`,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${auth}`
        },
        data: 'grant_type=client_credentials'
      });

      return response.data.access_token;
    } catch (error) {
      logger.error('Erreur lors de l\'obtention du token d\'accès PayPal', {
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Vérifie le statut d'un ordre PayPal
   */
  static async checkPaymentStatus(orderId: string): Promise<string> {
    try {
      const accessToken = await PayPalClient.getAccessToken();

      const response = await axios({
        method: 'get',
        url: `${paypalApiBaseUrl}/v2/checkout/orders/${orderId}`,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`
        }
      });

      return response.data.status;
    } catch (error) {
      logger.error('Erreur lors de la vérification du statut du paiement', {
        error: error instanceof Error ? error.message : String(error),
        orderId
      });
      throw error;
    }
  }

  /**
   * Récupère les détails d'une capture de paiement
   */
  static async getCaptureDetails(captureId: string, accessToken: string): Promise<{
    amount: number;
    currency: string;
    status: string;
  }> {
    try {
      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      };

      const response = await axios.get(
        `${paypalApiBaseUrl}/v2/payments/captures/${captureId}`,
        { headers }
      );

      const captureData = response.data;
      const value = parseFloat(captureData.amount.value);
      const currency = captureData.amount.currency_code;

      return {
        amount: value,
        currency,
        status: captureData.status
      };
    } catch (error: any) {
      logger.error('Erreur lors de la récupération des détails de la capture', {
        captureId: captureId.substring(0, 5) + '...',
        error: error.message,
        statusCode: error.response?.status,
        details: error.response?.data
      });
      throw new Error('Impossible de récupérer les détails de la capture PayPal');
    }
  }
}
