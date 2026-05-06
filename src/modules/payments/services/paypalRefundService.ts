import axios, { AxiosError } from 'axios';
import { PayPalClient, paypalApiBaseUrl } from './paypalClient';
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
  accessToken: string
): Promise<{ id: string; status: string }> {
  const response = await axios.post(REFUND_ENDPOINT(captureId), requestBody, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      'PayPal-Request-Id': `refund_${captureId}_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`,
      Prefer: 'return=representation'
    }
  });
  return { id: response.data.id, status: response.data.status };
}

export class PayPalRefundService {
  /**
   * Effectue un remboursement (total ou partiel) sur une capture PayPal.
   *
   * Stratégie :
   *  1. Si le vendeur a un access_token OAuth valide avec le scope refund
   *     → appel direct avec son token (voie cible pour la production avec
   *     scopes étendus / Partner setup).
   *  2. Sinon → token plateforme client_credentials. Fonctionne en sandbox
   *     PayPal (les apps sandbox peuvent rembourser leurs propres comptes
   *     business sans Auth-Assertion). En production hors Partner, ce flux
   *     échouera et l'erreur sera remontée explicitement.
   *
   * Note : `PayPal-Auth-Assertion` (mode partenaire) n'est plus tenté par
   * défaut — il échoue systématiquement en 401 sur les apps non-Partner et
   * ajoute du bruit dans les logs.
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

    const platformAccessToken = await PayPalClient.getAccessToken();
    const captureDetails = await PayPalClient.getCaptureDetails(captureId, platformAccessToken);

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

    const sellerAccessToken = await PayPalClient.getSellerAccessToken(sellerId);

    logger.info('Préparation d\'un remboursement ' + (amount !== null ? 'partiel' : 'complet'), {
      captureId: maskedCaptureId,
      amount,
      currency: captureDetails.currency,
      maxRefundable: captureDetails.amount,
      hasSellerOAuth: Boolean(sellerAccessToken)
    });

    // Tentative 1 : token vendeur OAuth si présent (voie cible production
    // avec scopes étendus). Tentative 2 : token plateforme — utilisée si la
    // tentative 1 est rejetée pour raison d'autorisation (scopes insuffisants),
    // ou directement si le vendeur n'a pas de tokens OAuth.
    const attempts: Array<{ token: string; source: 'seller_oauth' | 'platform' }> = [];
    if (sellerAccessToken) {
      attempts.push({ token: sellerAccessToken, source: 'seller_oauth' });
    }
    attempts.push({ token: platformAccessToken, source: 'platform' });

    let lastDesc: PayPalErrorDescription | null = null;
    let lastKind: 'auth' | 'business' | 'unknown' = 'unknown';
    let lastError: any = null;

    for (let i = 0; i < attempts.length; i++) {
      const { token, source } = attempts[i];
      try {
        const result = await callPayPalRefund(captureId, requestBody, token);
        logger.info('Remboursement effectué', {
          captureId: maskedCaptureId,
          refundId: result.id,
          status: result.status,
          tokenSource: source
        });
        return { id: result.id, status: result.status, createdAt: new Date() };
      } catch (error: any) {
        const desc = describePayPalError(error as AxiosError);
        const kind = classifyError(desc);
        lastDesc = desc;
        lastKind = kind;
        lastError = error;

        logger.warn('Refund PayPal rejeté', {
          captureId: maskedCaptureId,
          tokenSource: source,
          status: desc.status,
          issues: desc.issues,
          message: desc.message,
          debugId: desc.debugId,
          kind
        });

        // Erreur métier (montant invalide, complaint case, déjà remboursé…) :
        // un autre token donnerait la même réponse, inutile de retry.
        if (kind === 'business') break;
        // Sur erreur d'auth, on enchaîne avec le token suivant (plateforme).
      }
    }

    if (lastDesc) {
      GdprLogger.logPaymentError(lastError, sellerId, { captureId, statusCode: lastDesc.status });
      throw new PayPalRefundError(
        translatePayPalIssue(lastDesc),
        lastKind,
        lastDesc.status || 502,
        lastDesc.issues,
        lastDesc.debugId
      );
    }

    throw new PayPalRefundError('Échec du remboursement PayPal', 'unknown', 502, []);
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
