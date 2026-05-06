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
 * Récupère l'email PayPal du vendeur après l'OAuth. PayPal expose deux
 * endpoints userinfo : la version v1.1 (oauth2/userinfo) plus récente, et
 * la version openid (openidconnect/userinfo) historique. Selon les comptes
 * sandbox et la combinaison de scopes, l'un peut renvoyer 401/200-no-email
 * tandis que l'autre fonctionne. On tente les deux dans l'ordre et on logge
 * précisément en cas d'échec, plutôt que d'avaler silencieusement.
 */
async function fetchPayPalEmail(accessToken: string): Promise<string | null> {
  const endpoints = [
    `${paypalApiBaseUrl}/v1/identity/oauth2/userinfo?schema=paypalv1.1`,
    `${paypalApiBaseUrl}/v1/identity/openidconnect/userinfo?schema=openid`
  ];

  for (const url of endpoints) {
    try {
      const response = await axios.get(url, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      const email: unknown = response.data?.email;
      if (typeof email === 'string' && email.includes('@')) {
        return email;
      }
      logger.warn('PayPal userinfo a répondu sans email', {
        endpoint: url,
        keys: Object.keys(response.data || {})
      });
    } catch (error: any) {
      logger.warn('PayPal userinfo a échoué', {
        endpoint: url,
        status: error.response?.status,
        message: error.response?.data?.error_description || error.response?.data?.message || error.message
      });
    }
  }

  return null;
}

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
    const baseUrl = process.env.PAYPAL_OAUTH_BASE_URL || process.env.API_URL || 'http://localhost:3000';
    const redirectUri = encodeURIComponent(`${baseUrl}/api/payments/paypal/callback`);
    const state = encodeURIComponent(sellerId);
    // openid + email : identité du vendeur (requis pour récupérer son paypalEmail).
    // payments/refund : autorise la plateforme à rembourser, en son nom, les
    // captures où il est `payee`. C'est ce scope qui permet d'appeler
    // /v2/payments/captures/{id}/refund avec son access_token. Il doit être
    // activé côté dashboard PayPal Developer (Features de l'app sandbox).
    const scope = encodeURIComponent('openid email https://uri.paypal.com/services/payments/refund');
    // prompt=login force PayPal à re-demander les identifiants même si une
    // session est déjà ouverte sur paypal.com — évite que l'OAuth ressorte
    // un compte déjà connecté que l'utilisateur ne voulait pas relier.
    return `${paypalWebBaseUrl}/signin/authorize?client_id=${process.env.PAYPAL_CLIENT_ID}&response_type=code&scope=${scope}&redirect_uri=${redirectUri}&state=${state}&prompt=login`;
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
      const baseUrl = process.env.PAYPAL_OAUTH_BASE_URL || process.env.API_URL || 'http://localhost:3000';

      const tokenResponse = await axios({
        method: 'post',
        url: `${paypalApiBaseUrl}/v1/oauth2/token`,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${auth}`
        },
        data: `grant_type=authorization_code&code=${code}&redirect_uri=${baseUrl}/api/payments/paypal/callback`
      });

      const { access_token, refresh_token, expires_in, scope: grantedScope } = tokenResponse.data;

      logger.info('PayPal OAuth token reçu', {
        hasAccessToken: !!access_token,
        hasRefreshToken: !!refresh_token,
        expiresIn: expires_in,
        grantedScope,
        canRefund: typeof grantedScope === 'string' && grantedScope.includes('https://uri.paypal.com/services/payments/refund')
      });

      // Récupérer l'email PayPal du vendeur. On essaie le nouvel endpoint
      // (oauth2/userinfo, paypalv1.1) puis l'ancien (openidconnect/userinfo,
      // openid). Si les deux échouent on laisse `paypalEmail` à null —
      // surtout pas de fallback sur `user.email` (= mail d'inscription
      // MyKpopTrade), qui ferait croire à un email PayPal valide alors qu'il
      // ne l'est pas et casserait `payee.email_address` au paiement suivant.
      const paypalEmail = await fetchPayPalEmail(access_token);

      if (!paypalEmail) {
        logger.warn('Email PayPal introuvable via userinfo après OAuth', {
          sellerId: sellerId.substring(0, 5) + '...',
          grantedScope
        });
      }

      user.paypalEmail = paypalEmail || undefined;
      user.paypalConnected = Boolean(paypalEmail);
      // On ne stocke les tokens que si PayPal a renvoyé un refresh_token
      // exploitable. Avec le scope LIPP `openid email` actuel, refresh_token
      // est généralement absent : tenter d'utiliser l'access_token comme
      // refresh_token mène à des échecs silencieux 60 minutes plus tard.
      if (refresh_token) {
        user.paypalTokens = {
          accessToken: access_token,
          refreshToken: refresh_token,
          expiresAt: new Date(Date.now() + (expires_in || 3600) * 1000)
        };
      }
      await user.save();

      logger.info('Compte PayPal connecté avec succès via OAuth', {
        email: paypalEmail,
        hasRefreshToken: !!refresh_token
      });

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
