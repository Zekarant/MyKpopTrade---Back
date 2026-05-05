import axios from 'axios';
import User from '../../../models/userModel';
import { PayPalClient, paypalApiBaseUrl } from './paypalClient';
import { GdprLogger } from '../../../commons/utils/gdprLogger';
import logger from '../../../commons/utils/logger';
import { formatForPayPal, gt } from '../../../commons/utils/moneyMath';

/**
 * Flux de remboursement PayPal.
 */
export class PayPalRefundService {
  /**
   * Construit le header PayPal-Auth-Assertion pour agir au nom du vendeur.
   * Format : base64({"alg":"none"}).base64({"iss":"<client_id>","email":"<seller_email>"}).
   */
  private static buildAuthAssertion(sellerEmail: string): string {
    const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      iss: process.env.PAYPAL_CLIENT_ID,
      email: sellerEmail
    })).toString('base64url');
    return `${header}.${payload}.`;
  }

  /**
   * Effectue un remboursement pour un paiement capturé.
   * @param captureId ID de la capture PayPal
   * @param amount Montant à rembourser (null pour remboursement complet)
   * @param reason Raison du remboursement
   * @param sellerId ID du vendeur
   */
  static async refundConnectedPayment(
    captureId: string,
    amount: number | null,
    reason: string,
    sellerId: string
  ): Promise<{ id: string; status: string; createdAt: Date }> {
    try {
      const maskedCaptureId = captureId.substring(0, 5) + '...';

      GdprLogger.logPaymentAction('remboursement_preparation', {
        captureId: maskedCaptureId,
        isPartial: amount !== null
      }, sellerId);

      const seller = await User.findById(sellerId);
      if (!seller) {
        throw new Error('Vendeur non trouvé');
      }

      // Utiliser le token de la plateforme + PayPal-Auth-Assertion pour agir
      // au nom du vendeur (les fonds sont sur son compte PayPal).
      const accessToken = await PayPalClient.getAccessToken();

      const sellerPaypalEmail = seller.paypalEmail;
      if (!sellerPaypalEmail) {
        throw new Error('Le vendeur n\'a pas d\'email PayPal configuré');
      }

      // Header PayPal-Auth-Assertion : permet à la plateforme d'effectuer
      // un remboursement depuis le compte du vendeur.
      const authAssertion = PayPalRefundService.buildAuthAssertion(sellerPaypalEmail);

      logger.debug('Utilisation du token plateforme + Auth-Assertion pour le remboursement', {
        sellerId: sellerId.substring(0, 5) + '...'
      });

      const captureDetails = await PayPalClient.getCaptureDetails(captureId, accessToken);

      logger.info('Préparation d\'un remboursement ' + (amount !== null ? 'partiel' : 'complet'), {
        captureId: maskedCaptureId,
        amount,
        currency: captureDetails.currency,
        maxRefundable: captureDetails.amount
      });

      let requestBody: any = {};

      if (amount !== null) {
        if (!Number.isFinite(amount) || amount <= 0) {
          throw new Error('Le montant du remboursement doit être strictement positif');
        }

        // Comparaison en cents : `0.1 + 0.2 !== 0.3` côté flottant.
        if (gt(amount, captureDetails.amount)) {
          throw new Error(`Le montant du remboursement (${formatForPayPal(amount)} ${captureDetails.currency}) est supérieur au montant capturé (${captureDetails.amount} ${captureDetails.currency})`);
        }

        requestBody = {
          amount: {
            value: formatForPayPal(amount),
            currency_code: captureDetails.currency
          },
          note_to_payer: (reason || 'Remboursement partiel').slice(0, 255)
        };
      } else {
        requestBody = {
          note_to_payer: (reason || 'Remboursement complet').slice(0, 255)
        };
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
        'PayPal-Auth-Assertion': authAssertion,
        'PayPal-Request-Id': `refund_${captureId}_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`,
        'Prefer': 'return=representation'
      };

      logger.debug('Corps de la requête de remboursement', {
        isPartial: amount !== null,
        captureId: maskedCaptureId,
        requestBody: JSON.stringify(requestBody)
      });

      const response = await axios.post(
        `${paypalApiBaseUrl}/v2/payments/captures/${captureId}/refund`,
        requestBody,
        { headers }
      );

      logger.info('Remboursement effectué avec succès', {
        captureId: maskedCaptureId,
        refundId: response.data.id,
        status: response.data.status
      });

      return {
        id: response.data.id,
        status: response.data.status,
        createdAt: new Date()
      };
    } catch (error: any) {
      const errorResponse = error.response?.data || {};
      const errorDetails = errorResponse.details || [];

      GdprLogger.logPaymentError(error, sellerId, {
        captureId,
        statusCode: error.response?.status,
        errorName: errorResponse.name
      });

      if (errorResponse.name === 'UNPROCESSABLE_ENTITY') {
        const hasIssue = (issue: string) =>
          errorDetails.some((detail: any) => detail.issue === issue);

        if (hasIssue('CAPTURE_FULLY_REFUNDED')) {
          throw new Error('Cette transaction a déjà été entièrement remboursée');
        }
        if (hasIssue('AMOUNT_MISMATCH') || hasIssue('INVALID_CURRENCY_CODE')) {
          throw new Error('Le montant ou la devise du remboursement est invalide');
        }
        if (hasIssue('DUPLICATE_INVOICE_ID')) {
          throw new Error('Un remboursement avec cet identifiant existe déjà');
        }
        if (hasIssue('MAX_NUMBER_OF_REFUNDS_EXCEEDED')) {
          throw new Error('Le nombre maximum de remboursements pour cette transaction a été atteint');
        }
        if (hasIssue('REFUND_TIME_LIMIT_EXCEEDED')) {
          throw new Error('Le délai de remboursement PayPal (180 jours) est dépassé');
        }
        if (hasIssue('REFUND_NOT_PERMITTED') || hasIssue('REFUND_NOT_ALLOWED')) {
          throw new Error('PayPal n\'autorise pas le remboursement de cette transaction');
        }
        if (hasIssue('REFUND_AMOUNT_EXCEEDED') || hasIssue('REFUND_CAPTURE_CURRENCY_MISMATCH')) {
          throw new Error('Le montant ou la devise dépasse ce qui est remboursable sur cette transaction');
        }
        if (hasIssue('PAYEE_ACCOUNT_NOT_SUPPORTED') || hasIssue('PAYEE_ACCOUNT_RESTRICTED')) {
          throw new Error('Le compte PayPal du vendeur ne permet pas ce remboursement');
        }
        if (hasIssue('TRANSACTION_REFUSED')) {
          throw new Error('PayPal a refusé l\'opération de remboursement');
        }
      }

      if (errorResponse.name === 'RESOURCE_NOT_FOUND') {
        throw new Error('La transaction à rembourser est introuvable côté PayPal');
      }

      if (errorResponse.name === 'AUTHENTICATION_FAILURE' || error.response?.status === 401) {
        throw new Error('Authentification PayPal invalide — vérifiez la configuration de la plateforme');
      }

      if (errorResponse.name === 'NOT_AUTHORIZED' || error.response?.status === 403) {
        throw new Error('La plateforme n\'est pas autorisée à rembourser pour ce vendeur (Auth-Assertion refusée)');
      }

      if (errorResponse.name === 'RATE_LIMIT_REACHED' || error.response?.status === 429) {
        throw new Error('Trop de requêtes vers PayPal — réessayez dans quelques instants');
      }

      throw new Error(
        errorResponse.message ||
        error.message ||
        'Erreur lors du remboursement'
      );
    }
  }
}
