import User from '../../../models/userModel';
import { paypalApiBaseUrl } from './paypalClient';
import logger from '../../../commons/utils/logger';
import axios from 'axios';

/**
 * URL de base web PayPal (différente de l'API)
 */
const paypalWebBaseUrl = process.env.NODE_ENV === 'production'
  ? 'https://www.paypal.com'
  : 'https://www.sandbox.paypal.com';

/**
 * OAuth connect PayPal pour vendeurs.
 */
export class PayPalConnectService {
  /**
   * Génère l'URL pour connecter un compte vendeur.
   * Utilise "Log in with PayPal" (signin/authorize endpoint).
   * 
   * IMPORTANT : Le redirect_uri DOIT être enregistré dans le dashboard PayPal Developer :
   * https://developer.paypal.com/dashboard/applications/sandbox/<APP_ID>
   * → "Log in with PayPal" → Return URL = http://localhost:3000/api/payments/paypal/callback
   */
  static generateConnectUrl(sellerId: string): string {
    const baseUrl = process.env.API_URL || 'http://localhost:3000';
    const redirectUri = encodeURIComponent(`${baseUrl}/api/payments/paypal/callback`);
    const state = encodeURIComponent(sellerId);

    return `${paypalWebBaseUrl}/signin/authorize?client_id=${process.env.PAYPAL_CLIENT_ID}&response_type=code&scope=openid%20email&redirect_uri=${redirectUri}&state=${state}`;
  }

  /**
   * Traite le callback de connexion PayPal — échange le code contre un token
   */
  static async handleConnectCallback(code: string, sellerId: string): Promise<boolean> {
    try {
      const user = await User.findById(sellerId);
      if (!user) return false;

      const clientId = process.env.PAYPAL_CLIENT_ID;
      const clientSecret = process.env.PAYPAL_CLIENT_SECRET;

      if (!clientId || !clientSecret) {
        throw new Error('Identifiants PayPal non configurés');
      }

      const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
      const baseUrl = process.env.API_URL || 'http://localhost:3000';

      const tokenResponse = await axios({
        method: 'post',
        url: `${paypalApiBaseUrl}/v1/oauth2/token`,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${auth}`
        },
        data: `grant_type=authorization_code&code=${code}&redirect_uri=${baseUrl}/api/payments/paypal/callback`
      });

      const { access_token, refresh_token, expires_in } = tokenResponse.data;

      // Récupérer l'email PayPal du vendeur
      let paypalEmail = user.email;
      try {
        const userInfoResponse = await axios.get(`${paypalApiBaseUrl}/v1/identity/openidconnect/userinfo?schema=openid`, {
          headers: { 'Authorization': `Bearer ${access_token}` }
        });
        if (userInfoResponse.data.email) {
          paypalEmail = userInfoResponse.data.email;
        }
      } catch {
        // Si on ne peut pas récupérer l'email, on utilise celui du compte
      }

      user.paypalEmail = paypalEmail;
      user.paypalConnected = true;
      user.paypalTokens = {
        accessToken: access_token,
        refreshToken: refresh_token || '',
        expiresAt: new Date(Date.now() + (expires_in || 3600) * 1000)
      };
      await user.save();

      return true;
    } catch (error) {
      logger.error('Erreur lors de la connexion du compte PayPal', {
        error: error instanceof Error ? error.message : String(error),
        sellerId: sellerId.substring(0, 5) + '...'
      });
      return false;
    }
  }
}
