import axios, { AxiosError } from 'axios';
import { PayPalClient, paypalApiBaseUrl, partnerHeaders } from './paypalClient';
import User from '../../../models/userModel';
import { GdprLogger } from '../../../commons/utils/gdprLogger';
import logger from '../../../commons/utils/logger';
import { formatForPayPal, gt } from '../../../commons/utils/moneyMath';

const REFUND_ENDPOINT = (captureId: string) =>
  `${paypalApiBaseUrl}/v2/payments/captures/${captureId}/refund`;

interface PayPalErrorDescription {
  message: string;
  status: number;
  issues: string[];
  debugId?: string;
}

/**
 * Erreur typée renvoyée par le service de refund. Le flag `kind` permet
 * aux appelants de réagir différemment selon qu'on a un refus PayPal pour
 * raison métier (ex. dispute ouverte → refund partiel interdit) ou un
 * problème d'autorisation (token invalide, scopes insuffisants).
 */
export class PayPalRefundError extends Error {
  readonly kind: 'business' | 'auth' | 'unknown';
  readonly status: number;
  readonly issues: string[];
  readonly debugId?: string;

  constructor(
    message: string,
    kind: 'business' | 'auth' | 'unknown',
    status: number,
    issues: string[],
    debugId?: string
  ) {
    super(message);
    this.name = 'PayPalRefundError';
    this.kind = kind;
    this.status = status;
    this.issues = issues;
    this.debugId = debugId;
  }
}

function describePayPalError(error: AxiosError): PayPalErrorDescription {
  const status = error.response?.status ?? 0;
  const data = (error.response?.data ?? {}) as any;
  const debugId = typeof data?.debug_id === 'string' ? data.debug_id : undefined;

  const issues: string[] = Array.isArray(data?.details)
    ? data.details.map((d: any) => d?.issue).filter(Boolean)
    : [];

  if (data?.message) {
    const detail = issues.length ? ` (${issues.join(', ')})` : '';
    return { message: `${data.message}${detail}`, status, issues, debugId };
  }

  if (typeof data === 'string' && data.length > 0) {
    return { message: data.slice(0, 250), status, issues, debugId };
  }

  if (issues.length) {
    return { message: `PayPal a rejeté le remboursement (${issues.join(', ')})`, status, issues, debugId };
  }

  return {
    message: `PayPal a renvoyé une erreur ${status || 'inconnue'} sans détail exploitable`,
    status,
    issues,
    debugId
  };
}

const AUTH_ISSUES = new Set([
  'NOT_AUTHORIZED',
  'PERMISSION_DENIED',
  'AUTHORIZATION_ERROR',
  'AUTHENTICATION_FAILURE'
]);

function classifyError(desc: PayPalErrorDescription): 'business' | 'auth' | 'unknown' {
  if (desc.status === 401 || desc.status === 403) return 'auth';
  if (desc.issues.some((i) => AUTH_ISSUES.has(i))) return 'auth';
  if (desc.status >= 400 && desc.status < 500) return 'business';
  return 'unknown';
}

async function callPayPalRefund(
  captureId: string,
  requestBody: any,
  accessToken: string,
  sellerMerchantId: string
): Promise<{ id: string; status: string; amount: number | null; currency: string | null }> {
  const response = await axios.post(REFUND_ENDPOINT(captureId), requestBody, {
    headers: {
      ...partnerHeaders({
        accessToken,
        sellerMerchantId,
        requestId: `refund_${captureId}_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`
      }),
      // `return=representation` fait renvoyer le montant réellement remboursé.
      // Indispensable : PayPal plafonne silencieusement une demande qui dépasse
      // le restant dû et répond COMPLETED — enregistrer le montant demandé
      // plutôt que celui-ci désaligne la compta du site et celle de PayPal.
      Prefer: 'return=representation'
    }
  });

  const value = response.data.amount?.value;

  return {
    id: response.data.id,
    status: response.data.status,
    amount: value !== undefined ? parseFloat(value) : null,
    currency: response.data.amount?.currency_code ?? null
  };
}

export class PayPalRefundService {
  /**
   * Effectue un remboursement (total ou partiel) sur une capture PayPal.
   *
   * Connected Path : l'appel est authentifié par le token plateforme et porte
   * le header `PayPal-Auth-Assertion` avec le merchant ID du vendeur — c'est lui
   * qui détient les fonds, donc c'est de son compte que part le remboursement.
   * Si le vendeur n'est plus relié à PayPal, on lève `RECONNECT_PAYPAL` pour que
   * le front lui propose de relancer l'onboarding.
   */
  static async refundConnectedPayment(
    captureId: string,
    amount: number | null,
    reason: string,
    sellerId: string
  ): Promise<{
    id: string;
    status: string;
    /** Montant réellement remboursé par PayPal, qui peut différer du demandé. */
    amount: number;
    currency: string;
    createdAt: Date;
  }> {
    const maskedCaptureId = captureId.substring(0, 5) + '...';

    GdprLogger.logPaymentAction('remboursement_preparation', {
      captureId: maskedCaptureId,
      isPartial: amount !== null
    }, sellerId);

    const seller = await User.findById(sellerId).select('paypalMerchantId');
    if (!seller?.paypalMerchantId) {
      throw new PayPalRefundError(
        'Votre compte PayPal n\'est plus relié à MyKpopTrade. Reconnectez-le pour pouvoir rembourser.',
        'auth',
        401,
        ['RECONNECT_PAYPAL']
      );
    }

    const sellerMerchantId = seller.paypalMerchantId;
    const accessToken = await PayPalClient.getAccessToken();
    const captureDetails = await PayPalClient.getCaptureDetails(captureId, sellerMerchantId);

    const requestBody: any = {};
    if (amount !== null) {
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new PayPalRefundError(
          'Le montant du remboursement doit être strictement positif',
          'business',
          400,
          []
        );
      }
      if (gt(amount, captureDetails.amount)) {
        throw new PayPalRefundError(
          `Le montant du remboursement (${formatForPayPal(amount)} ${captureDetails.currency}) est supérieur au montant capturé (${captureDetails.amount} ${captureDetails.currency})`,
          'business',
          400,
          []
        );
      }
      requestBody.amount = {
        value: formatForPayPal(amount),
        currency_code: captureDetails.currency
      };
      requestBody.note_to_payer = (reason || 'Remboursement partiel').slice(0, 255);
    } else {
      requestBody.note_to_payer = (reason || 'Remboursement complet').slice(0, 255);
    }

    logger.info('Préparation d\'un remboursement ' + (amount !== null ? 'partiel' : 'complet'), {
      captureId: maskedCaptureId,
      amount,
      currency: captureDetails.currency,
      maxRefundable: captureDetails.amount
    });

    try {
      const result = await callPayPalRefund(captureId, requestBody, accessToken, sellerMerchantId);
      const settledAmount = result.amount ?? amount ?? captureDetails.amount;

      if (amount !== null && result.amount !== null && result.amount !== amount) {
        logger.warn('PayPal a remboursé un montant différent de celui demandé', {
          captureId: maskedCaptureId,
          requested: amount,
          settled: result.amount
        });
      }

      logger.info('Remboursement effectué', {
        captureId: maskedCaptureId,
        refundId: result.id,
        status: result.status,
        amount: settledAmount
      });

      return {
        id: result.id,
        status: result.status,
        amount: settledAmount,
        currency: result.currency ?? captureDetails.currency,
        createdAt: new Date()
      };
    } catch (error: any) {
      const desc = describePayPalError(error as AxiosError);
      const kind = classifyError(desc);

      logger.warn('Refund PayPal rejeté', {
        captureId: maskedCaptureId,
        status: desc.status,
        issues: desc.issues,
        message: desc.message,
        debugId: desc.debugId,
        kind
      });

      GdprLogger.logPaymentError(error, sellerId, { captureId, statusCode: desc.status });

      // Une auth-failure ici signifie que le vendeur a révoqué les permissions
      // accordées à MyKpopTrade côté PayPal : on demande un ré-onboarding.
      if (kind === 'auth') {
        throw new PayPalRefundError(
          'MyKpopTrade n\'est plus autorisé à rembourser depuis votre compte PayPal. Reconnectez votre compte pour réaccorder les permissions.',
          'auth',
          401,
          desc.issues.length ? desc.issues : ['RECONNECT_PAYPAL'],
          desc.debugId
        );
      }

      throw new PayPalRefundError(
        translatePayPalIssue(desc),
        kind,
        desc.status || 502,
        desc.issues,
        desc.debugId
      );
    }
  }
}

/**
 * Traduit un code d'issue PayPal en message utilisateur. Quand on n'a pas de
 * mapping par code, on inspecte le `message` brut pour les cas connus
 * remontés en texte libre par PayPal (ex. dispute / complaint case), puis
 * on retourne le message PayPal en dernier ressort.
 */
function translatePayPalIssue(desc: PayPalErrorDescription): string {
  const known: Record<string, string> = {
    // Exigence IWT : le solde vendeur insuffisant doit être traité proprement,
    // avec une action claire, et non remonté comme une erreur technique.
    INSUFFICIENT_FUNDS:
      'Le solde de votre compte PayPal est insuffisant pour ce remboursement. Approvisionnez votre compte PayPal (ou reliez-y votre compte bancaire), puis relancez le remboursement.',
    SENDER_RESTRICTED:
      'Votre compte PayPal est actuellement restreint et ne permet pas d\'émettre ce remboursement. Contactez le support PayPal.',
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

  // PayPal peut renvoyer ces cas en texte libre (sans `details[].issue`).
  const lower = desc.message.toLowerCase();
  if (lower.includes('complaint case') || lower.includes('dispute')) {
    return 'Cette transaction fait l\'objet d\'une réclamation PayPal — seul un remboursement total est autorisé tant que le litige est ouvert';
  }
  if (lower.includes('fully refunded')) {
    return 'Cette transaction a déjà été entièrement remboursée';
  }

  if (desc.status === 401) return 'Authentification PayPal invalide — vérifiez la configuration plateforme';
  if (desc.status === 403) return 'PayPal a refusé l\'opération (permissions insuffisantes)';
  if (desc.status === 429) return 'Trop de requêtes vers PayPal — réessayez dans quelques instants';
  return desc.message;
}
