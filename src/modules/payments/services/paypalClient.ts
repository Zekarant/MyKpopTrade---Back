import axios from 'axios';
import logger from '../../../commons/utils/logger';
import User from '../../../models/userModel';

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

  /**
   * Rafraîchit le token OAuth d'un vendeur via son refresh_token.
   * Met à jour les champs paypalTokens du user en base.
   * Retourne le nouveau access_token.
   */
  static async refreshSellerToken(sellerId: string): Promise<string> {
    const user = await User.findById(sellerId).select('+paypalTokens.accessToken +paypalTokens.refreshToken +paypalTokens.expiresAt');
    if (!user || !user.paypalTokens?.refreshToken) {
      throw new Error('Aucun refresh token PayPal disponible pour ce vendeur');
    }

    const clientId = process.env.PAYPAL_CLIENT_ID;
    const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error('Identifiants PayPal non configurés');
    }

    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    try {
      const response = await axios({
        method: 'post',
        url: `${paypalApiBaseUrl}/v1/oauth2/token`,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${auth}`
        },
        data: `grant_type=refresh_token&refresh_token=${user.paypalTokens.refreshToken}`
      });

      const { access_token, refresh_token, expires_in, scope: grantedScope } = response.data;

      user.paypalTokens = {
        accessToken: access_token,
        refreshToken: refresh_token || user.paypalTokens.refreshToken,
        expiresAt: new Date(Date.now() + (expires_in || 3600) * 1000)
      };
      await user.save();

      logger.info('Token PayPal vendeur rafraîchi', {
        sellerId: sellerId.substring(0, 5) + '...',
        grantedScope,
        canRefund: typeof grantedScope === 'string' && grantedScope.includes('https://uri.paypal.com/services/payments/refund')
      });
      return access_token;
    } catch (error: any) {
      logger.error('Échec du refresh token PayPal vendeur', {
        sellerId: sellerId.substring(0, 5) + '...',
        error: error.message,
        status: error.response?.status
      });
      throw new Error('Impossible de rafraîchir le token PayPal du vendeur');
    }
  }

  /**
   * Récupère un access_token valide pour un vendeur.
   * Si le token est expiré, le rafraîchit automatiquement.
   * Retourne null si le vendeur n'a pas de tokens OAuth.
   */
  static async getSellerAccessToken(sellerId: string): Promise<string | null> {
    const user = await User.findById(sellerId).select('+paypalTokens.accessToken +paypalTokens.refreshToken +paypalTokens.expiresAt');
    if (!user || !user.paypalTokens?.accessToken) {
      return null;
    }

    const now = new Date();
    const expiresAt = user.paypalTokens.expiresAt ? new Date(user.paypalTokens.expiresAt) : null;

    // Rafraîchir si expiré ou expire dans les 5 prochaines minutes
    if (!expiresAt || expiresAt.getTime() - now.getTime() < 5 * 60 * 1000) {
      if (!user.paypalTokens.refreshToken) {
        return null;
      }
      return await PayPalClient.refreshSellerToken(sellerId);
    }

    return user.paypalTokens.accessToken;
  }
}
