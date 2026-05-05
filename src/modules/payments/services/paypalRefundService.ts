import axios, { AxiosError } from 'axios';
import User from '../../../models/userModel';
import { PayPalClient, paypalApiBaseUrl } from './paypalClient';
import { GdprLogger } from '../../../commons/utils/gdprLogger';
import logger from '../../../commons/utils/logger';
import { formatForPayPal, gt } from '../../../commons/utils/moneyMath';

const REFUND_ENDPOINT = (captureId: string) =>
  `${paypalApiBaseUrl}/v2/payments/captures/${captureId}/refund`;

/**
 * Construit le header PayPal-Auth-Assertion pour agir au nom du vendeur.
 * Format JWS sans signature : base64({"alg":"none"}).base64({"iss":"<client_id>","email":"<seller_email>"}).
 */
function buildAuthAssertion(sellerEmail: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: process.env.PAYPAL_CLIENT_ID,
    email: sellerEmail
  })).toString('base64url');
  return `${header}.${payload}.`;
}

/**
 * Extrait un message lisible depuis une erreur PayPal, couvrant les
 * différentes formes de réponses (objet structuré, string, debug_id seul).
 */
function describePayPalError(error: AxiosError): { message: string; status: number; issues: string[] } {
  const status = error.response?.status ?? 0;
  const data = (error.response?.data ?? {}) as any;

  const issues: string[] = Array.isArray(data?.details)
    ? data.details.map((d: any) => d?.issue).filter(Boolean)
    : [];

  if (data?.message) {
    const detail = issues.length ? ` (${issues.join(', ')})` : '';
    return { message: `${data.message}${detail}`, status, issues };
  }

  if (typeof data === 'string' && data.length > 0) {
    return { message: data.slice(0, 250), status, issues };
  }

  if (issues.length) {
    return { message: `PayPal a rejeté le remboursement (${issues.join(', ')})`, status, issues };
  }

  return {
    message: `PayPal a renvoyé une erreur ${status || 'inconnue'} sans détail exploitable`,
    status,
    issues
  };
}

/**
 * Lance la requête HTTP de remboursement contre PayPal.
 * Isolée pour pouvoir retry avec/sans PayPal-Auth-Assertion.
 */
async function callPayPalRefund(
  captureId: string,
  requestBody: any,
  accessToken: string,
  authAssertion: string | null
): Promise<{ id: string; status: string }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
    'PayPal-Request-Id': `refund_${captureId}_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`,
    Prefer: 'return=representation'
  };
  if (authAssertion) {
    headers['PayPal-Auth-Assertion'] = authAssertion;
  }

  const response = await axios.post(REFUND_ENDPOINT(captureId), requestBody, { headers });
  return { id: response.data.id, status: response.data.status };
}

/**
 * Vrai indicateur de l'échec dû à l'Auth-Assertion : PayPal renvoie 401/403
 * ou un 400/422 sur des codes connus quand l'header est rejeté.
 */
function looksLikeAuthAssertionRejection(error: AxiosError): boolean {
  const status = error.response?.status;
  const data = (error.response?.data ?? {}) as any;
  const issues: string[] = Array.isArray(data?.details)
    ? data.details.map((d: any) => d?.issue)
    : [];
  if (status === 401 || status === 403) return true;
  if ((status === 400 || status === 422) && issues.some((i) =>
    ['NOT_AUTHORIZED', 'PERMISSION_DENIED', 'AUTHORIZATION_ERROR', 'AUTHENTICATION_FAILURE'].includes(i)
  )) {
    return true;
  }
  return false;
}

export class PayPalRefundService {
  /**
   * Effectue un remboursement (total ou partiel) sur une capture PayPal.
   *
   * Stratégie :
   *  1. Essai avec PayPal-Auth-Assertion (mode partenaire/marketplace).
   *  2. Si rejeté (401/403/400 lié à l'autorisation), retry SANS l'header.
   *     Aligné sur le comportement de `captureConnectedPayment` : le payee
   *     est explicitement défini sur l'order, donc la plateforme peut
   *     rembourser via son propre token sans Auth-Assertion en sandbox /
   *     hors statut Marketplace Partner.
   *  3. Mapping fin des codes d'erreur PayPal pour un message utilisateur clair.
   */
  static async refundConnectedPayment(
    captureId: string,
    amount: number | null,
    reason: string,
    sellerId: string
  ): Promise<{ id: string; status: string; createdAt: Date }> {
    const maskedCaptureId = captureId.substring(0, 5) + '...';

    GdprLogger.logPaymentAction('remboursement_preparation', {
      captureId: maskedCaptureId,
      isPartial: amount !== null
    }, sellerId);

    const seller = await User.findById(sellerId);
    if (!seller) {
      throw new Error('Vendeur non trouvé');
    }

    const accessToken = await PayPalClient.getAccessToken();

    const captureDetails = await PayPalClient.getCaptureDetails(captureId, accessToken);

    logger.info('Préparation d\'un remboursement ' + (amount !== null ? 'partiel' : 'complet'), {
      captureId: maskedCaptureId,
      amount,
      currency: captureDetails.currency,
      maxRefundable: captureDetails.amount
    });

    const requestBody: any = {};
    if (amount !== null) {
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error('Le montant du remboursement doit être strictement positif');
      }
      if (gt(amount, captureDetails.amount)) {
        throw new Error(`Le montant du remboursement (${formatForPayPal(amount)} ${captureDetails.currency}) est supérieur au montant capturé (${captureDetails.amount} ${captureDetails.currency})`);
      }
      requestBody.amount = {
        value: formatForPayPal(amount),
        currency_code: captureDetails.currency
      };
      requestBody.note_to_payer = (reason || 'Remboursement partiel').slice(0, 255);
    } else {
      requestBody.note_to_payer = (reason || 'Remboursement complet').slice(0, 255);
    }

    const sellerPaypalEmail = seller.paypalEmail;
    const authAssertion = sellerPaypalEmail ? buildAuthAssertion(sellerPaypalEmail) : null;

    try {
      const result = await callPayPalRefund(captureId, requestBody, accessToken, authAssertion);
      logger.info('Remboursement effectué', {
        captureId: maskedCaptureId,
        refundId: result.id,
        status: result.status
      });
      return { id: result.id, status: result.status, createdAt: new Date() };
    } catch (firstError: any) {
      const firstDescription = describePayPalError(firstError as AxiosError);
      logger.warn('Premier essai de remboursement échoué', {
        captureId: maskedCaptureId,
        status: firstDescription.status,
        message: firstDescription.message,
        issues: firstDescription.issues,
        usedAuthAssertion: Boolean(authAssertion)
      });

      // Retry sans Auth-Assertion si on l'avait envoyé et que c'est probablement la cause.
      const shouldRetryWithoutAssertion = Boolean(authAssertion) &&
        looksLikeAuthAssertionRejection(firstError as AxiosError);

      if (shouldRetryWithoutAssertion) {
        try {
          const result = await callPayPalRefund(captureId, requestBody, accessToken, null);
          logger.info('Remboursement effectué après retry sans Auth-Assertion', {
            captureId: maskedCaptureId,
            refundId: result.id
          });
          return { id: result.id, status: result.status, createdAt: new Date() };
        } catch (secondError: any) {
          const secondDescription = describePayPalError(secondError as AxiosError);
          logger.error('Refund échoué même sans Auth-Assertion', {
            captureId: maskedCaptureId,
            ...secondDescription
          });
          GdprLogger.logPaymentError(secondError, sellerId, { captureId, statusCode: secondDescription.status });
          throw new Error(translatePayPalIssue(secondDescription));
        }
      }

      GdprLogger.logPaymentError(firstError, sellerId, { captureId, statusCode: firstDescription.status });
      throw new Error(translatePayPalIssue(firstDescription));
    }
  }
}

/**
 * Traduit un code d'issue PayPal en message utilisateur. Quand on n'a pas de
 * mapping, on renvoie le `message` PayPal brut — toujours plus utile que
 * "Request failed with status code 400".
 */
function translatePayPalIssue(desc: { message: string; status: number; issues: string[] }): string {
  const known: Record<string, string> = {
    CAPTURE_FULLY_REFUNDED: 'Cette transaction a déjà été entièrement remboursée',
    AMOUNT_MISMATCH: 'Le montant du remboursement est invalide',
    INVALID_CURRENCY_CODE: 'La devise du remboursement est invalide',
    DUPLICATE_INVOICE_ID: 'Un remboursement avec cet identifiant existe déjà',
    MAX_NUMBER_OF_REFUNDS_EXCEEDED: 'Le nombre maximum de remboursements pour cette transaction a été atteint',
    REFUND_TIME_LIMIT_EXCEEDED: 'Le délai de remboursement PayPal (180 jours) est dépassé',
    REFUND_NOT_PERMITTED: 'PayPal n\'autorise pas le remboursement de cette transaction',
    REFUND_NOT_ALLOWED: 'PayPal n\'autorise pas le remboursement de cette transaction',
    REFUND_AMOUNT_EXCEEDED: 'Le montant dépasse ce qui est remboursable',
    REFUND_CAPTURE_CURRENCY_MISMATCH: 'La devise du remboursement diffère de celle de la capture',
    PAYEE_ACCOUNT_NOT_SUPPORTED: 'Le compte PayPal du vendeur ne permet pas ce remboursement',
    PAYEE_ACCOUNT_RESTRICTED: 'Le compte PayPal du vendeur est restreint',
    TRANSACTION_REFUSED: 'PayPal a refusé l\'opération',
    NOT_AUTHORIZED: 'La plateforme n\'est pas autorisée à effectuer ce remboursement',
    PERMISSION_DENIED: 'Permissions PayPal insuffisantes pour rembourser ce paiement',
    AUTHENTICATION_FAILURE: 'Authentification PayPal invalide',
    AUTHORIZATION_ERROR: 'Authentification PayPal invalide',
    INVALID_RESOURCE_ID: 'La capture PayPal référencée est introuvable ou invalide',
    RESOURCE_NOT_FOUND: 'La transaction à rembourser est introuvable côté PayPal'
  };
  for (const issue of desc.issues) {
    if (known[issue]) return known[issue];
  }
  if (desc.status === 401) return 'Authentification PayPal invalide — vérifiez la configuration plateforme';
  if (desc.status === 403) return 'PayPal a refusé l\'opération (permissions insuffisantes)';
  if (desc.status === 429) return 'Trop de requêtes vers PayPal — réessayez dans quelques instants';
  return desc.message;
}
