import User from '../../../models/userModel';
import { paypalApiBaseUrl } from './paypalClient';
import logger from '../../../commons/utils/logger';

/**
 * OAuth connect PayPal (legacy — conservé pour compatibilité avec le code historique).
 */
export class PayPalConnectService {
  /**
   * Génère l'URL pour connecter un compte vendeur
   */
  static generateConnectUrl(sellerId: string): string {
    const baseUrl = process.env.API_URL || 'http://localhost:3000/api';
    const redirectUri = encodeURIComponent(`${baseUrl}/connect/paypal/callback`);
    const state = encodeURIComponent(sellerId);

    return `${paypalApiBaseUrl}/connect/oauth2/authorize?flowEntry=static&client_id=${process.env.PAYPAL_CLIENT_ID}&response_type=code&scope=email%20payments&redirect_uri=${redirectUri}&state=${state}`;
  }

  /**
   * Traite le callback de connexion PayPal
   */
  static async handleConnectCallback(code: string, sellerId: string): Promise<boolean> {
    try {
      const user = await User.findById(sellerId);
      if (!user) return false;

      user.paypalEmail = user.email;
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
