import axios, { AxiosError } from 'axios';
import logger from '../../../commons/utils/logger';
import { paymentConfig } from '../../../config/paymentConfig';

/**
 * URL de base de l'API PayPal. Pilotée par `PAYPAL_MODE` (et non par NODE_ENV) :
 * c'est le seul commutateur explicite, et `validatePaymentConfig()` refuse le
 * mode `live` hors production.
 */
export const paypalApiBaseUrl = paymentConfig.paypal.mode === 'live'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

/** Marge avant expiration en dessous de laquelle on renouvelle le token. */
const TOKEN_EXPIRY_MARGIN_MS = 5 * 60 * 1000;

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

/**
 * Token plateforme mis en cache en mémoire. L'IWT exige explicitement que les
 * access tokens PayPal soient réutilisés jusqu'à leur expiration plutôt que
 * redemandés à chaque appel.
 */
let cachedPartnerToken: CachedToken | null = null;
/** Requête d'obtention en vol, pour éviter N appels concurrents au démarrage. */
let inFlightTokenRequest: Promise<string> | null = null;

/**
 * Extrait le debug ID renvoyé par PayPal. Le guide d'intégration demande de le
 * journaliser systématiquement : c'est la clé qui permet à PayPal de retrouver
 * la transaction dans leurs logs. `paypal-debug-id`, `debug_id` et
 * `correlation-id` portent la même valeur.
 */
export function extractDebugId(error: unknown): string | undefined {
  const axiosError = error as AxiosError<any>;
  return (
    axiosError?.response?.headers?.['paypal-debug-id'] ||
    axiosError?.response?.data?.debug_id ||
    undefined
  );
}

/**
 * Construit l'assertion d'authentification qui identifie le vendeur pour lequel
 * la plateforme agit. C'est le mécanisme Connected Path qui remplace la
 * détention d'un access token par vendeur : un JWT non signé (`alg: none`)
 * accepté par PayPal parce que la requête est déjà authentifiée par le token
 * OAuth de la plateforme.
 *
 * @see https://developer.paypal.com/api/rest/requests/#paypal-auth-assertion
 */
export function buildAuthAssertion(sellerMerchantId: string): string {
  const clientId = paymentConfig.paypal.clientId;
  if (!clientId) {
    throw new Error('PAYPAL_CLIENT_ID non configuré : impossible de construire l\'auth assertion');
  }
  if (!sellerMerchantId) {
    throw new Error('Merchant ID vendeur manquant : impossible de construire l\'auth assertion');
  }

  const encode = (payload: object) =>
    Buffer.from(JSON.stringify(payload)).toString('base64url');

  const header = encode({ alg: 'none' });
  const body = encode({ iss: clientId, payer_id: sellerMerchantId });

  // Signature volontairement vide — `alg: none`.
  return `${header}.${body}.`;
}

/**
 * Headers communs à tous les appels partenaires.
 * Le BN code est obligatoire (exigence contractuelle PayPal).
 */
export function partnerHeaders(options: {
  accessToken: string;
  sellerMerchantId?: string;
  requestId?: string;
} = { accessToken: '' }): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${options.accessToken}`,
    'PayPal-Partner-Attribution-Id': paymentConfig.paypal.bnCode
  };

  if (options.sellerMerchantId) {
    headers['PayPal-Auth-Assertion'] = buildAuthAssertion(options.sellerMerchantId);
  }

  if (options.requestId) {
    headers['PayPal-Request-Id'] = options.requestId;
  }

  return headers;
}

/**
 * Low-level PayPal API client : token plateforme, lecture d'ordres, captures.
 * Ne contient aucune logique métier — uniquement des appels HTTP typés.
 */
export class PayPalClient {
  /**
   * Obtient un token d'accès plateforme (client_credentials), mis en cache
   * jusqu'à 5 minutes avant son expiration.
   */
  static async getAccessToken(): Promise<string> {
    if (cachedPartnerToken && cachedPartnerToken.expiresAt > Date.now()) {
      return cachedPartnerToken.accessToken;
    }

    if (inFlightTokenRequest) {
      return inFlightTokenRequest;
    }

    inFlightTokenRequest = PayPalClient.requestAccessToken().finally(() => {
      inFlightTokenRequest = null;
    });

    return inFlightTokenRequest;
  }

  private static async requestAccessToken(): Promise<string> {
    const clientId = paymentConfig.paypal.clientId;
    const clientSecret = paymentConfig.paypal.clientSecret;

    if (!clientId || !clientSecret) {
      throw new Error('Les identifiants PayPal ne sont pas configurés');
    }

    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    try {
      const response = await axios({
        method: 'post',
        url: `${paypalApiBaseUrl}/v1/oauth2/token`,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${auth}`
        },
        data: 'grant_type=client_credentials'
      });

      const { access_token, expires_in } = response.data;

      cachedPartnerToken = {
        accessToken: access_token,
        expiresAt: Date.now() + ((expires_in || 3600) * 1000) - TOKEN_EXPIRY_MARGIN_MS
      };

      return access_token;
    } catch (error) {
      cachedPartnerToken = null;
      logger.error('Erreur lors de l\'obtention du token d\'accès PayPal', {
        error: error instanceof Error ? error.message : String(error),
        debugId: extractDebugId(error)
      });
      throw error;
    }
  }

  /** Invalide le token en cache (utile après un 401 inattendu). */
  static resetTokenCache(): void {
    cachedPartnerToken = null;
  }

  /**
   * Vérifie le statut d'un ordre PayPal
   */
  static async checkPaymentStatus(orderId: string): Promise<string> {
    try {
      const accessToken = await PayPalClient.getAccessToken();

      const response = await axios.get(
        `${paypalApiBaseUrl}/v2/checkout/orders/${orderId}`,
        { headers: partnerHeaders({ accessToken }) }
      );

      return response.data.status;
    } catch (error) {
      logger.error('Erreur lors de la vérification du statut du paiement', {
        error: error instanceof Error ? error.message : String(error),
        orderId,
        debugId: extractDebugId(error)
      });
      throw error;
    }
  }

  /**
   * Récupère les détails d'une capture de paiement.
   * `sellerMerchantId` permet à la plateforme de lire une capture dont le
   * bénéficiaire est le vendeur (via l'auth assertion).
   */
  static async getCaptureDetails(captureId: string, sellerMerchantId?: string): Promise<{
    amount: number;
    currency: string;
    status: string;
  }> {
    try {
      const accessToken = await PayPalClient.getAccessToken();

      const response = await axios.get(
        `${paypalApiBaseUrl}/v2/payments/captures/${captureId}`,
        { headers: partnerHeaders({ accessToken, sellerMerchantId }) }
      );

      const captureData = response.data;

      return {
        amount: parseFloat(captureData.amount.value),
        currency: captureData.amount.currency_code,
        status: captureData.status
      };
    } catch (error: any) {
      logger.error('Erreur lors de la récupération des détails de la capture', {
        captureId: captureId.substring(0, 5) + '...',
        error: error.message,
        statusCode: error.response?.status,
        debugId: extractDebugId(error)
      });
      throw new Error('Impossible de récupérer les détails de la capture PayPal');
    }
  }

  /**
   * Vérifie la signature d'un webhook auprès de PayPal.
   *
   * Sans cette vérification, n'importe qui connaissant l'URL du webhook peut
   * forger un `PAYMENT.CAPTURE.COMPLETED` et faire passer une commande en payée.
   */
  static async verifyWebhookSignature(
    headers: Record<string, any>,
    event: unknown
  ): Promise<boolean> {
    const webhookId = paymentConfig.paypal.webhookId;
    if (!webhookId) {
      logger.error('PAYPAL_WEBHOOK_ID non configuré — webhook rejeté');
      return false;
    }

    const header = (name: string): string | undefined => {
      const value = headers[name] ?? headers[name.toLowerCase()];
      return Array.isArray(value) ? value[0] : value;
    };

    const requiredHeaders = {
      auth_algo: header('paypal-auth-algo'),
      cert_url: header('paypal-cert-url'),
      transmission_id: header('paypal-transmission-id'),
      transmission_sig: header('paypal-transmission-sig'),
      transmission_time: header('paypal-transmission-time')
    };

    const missing = Object.entries(requiredHeaders)
      .filter(([, value]) => !value)
      .map(([key]) => key);

    if (missing.length > 0) {
      logger.warn('Webhook PayPal sans headers de signature', { missing });
      return false;
    }

    try {
      const accessToken = await PayPalClient.getAccessToken();

      const response = await axios.post(
        `${paypalApiBaseUrl}/v1/notifications/verify-webhook-signature`,
        { ...requiredHeaders, webhook_id: webhookId, webhook_event: event },
        { headers: partnerHeaders({ accessToken }) }
      );

      const verified = response.data.verification_status === 'SUCCESS';
      if (!verified) {
        logger.warn('Signature de webhook PayPal invalide', {
          verificationStatus: response.data.verification_status,
          transmissionId: requiredHeaders.transmission_id
        });
      }
      return verified;
    } catch (error) {
      logger.error('Échec de la vérification de signature du webhook PayPal', {
        error: error instanceof Error ? error.message : String(error),
        debugId: extractDebugId(error)
      });
      return false;
    }
  }
}
