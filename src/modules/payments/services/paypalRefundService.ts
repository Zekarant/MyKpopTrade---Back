import axios from 'axios';
import User from '../../../models/userModel';
import { PayPalClient, paypalApiBaseUrl } from './paypalClient';
import { GdprLogger } from '../../../commons/utils/gdprLogger';
import logger from '../../../commons/utils/logger';

/**
 * Flux de remboursement PayPal.
 */
export class PayPalRefundService {
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

      let accessToken: string;

      if (seller.paypalTokens && seller.paypalTokens.accessToken) {
        accessToken = seller.paypalTokens.accessToken;
        logger.debug('Utilisation du token d\'accès du vendeur', {
          sellerId: sellerId.substring(0, 5) + '...'
        });
      } else {
        accessToken = await PayPalClient.getAccessToken();
        logger.debug('Utilisation du token d\'accès de l\'application', {
          sellerId: sellerId.substring(0, 5) + '...'
        });
      }

      const captureDetails = await PayPalClient.getCaptureDetails(captureId, accessToken);

      logger.info('Préparation d\'un remboursement ' + (amount !== null ? 'partiel' : 'complet'), {
        captureId: maskedCaptureId,
        amount,
        currency: captureDetails.currency,
        maxRefundable: captureDetails.amount
      });

      let requestBody: any = {};

      if (amount !== null) {
        const formattedAmount = parseFloat(amount.toString()).toFixed(2);

        requestBody = {
          amount: {
            value: formattedAmount,
            currency_code: captureDetails.currency
          },
          note_to_payer: reason || 'Remboursement partiel'
        };

        if (parseFloat(formattedAmount) > captureDetails.amount) {
          throw new Error(`Le montant du remboursement (${formattedAmount} ${captureDetails.currency}) est supérieur au montant capturé (${captureDetails.amount} ${captureDetails.currency})`);
        }
      } else {
        requestBody = {
          note_to_payer: reason || 'Remboursement complet'
        };
      }

      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
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
        if (errorDetails.some((detail: any) => detail.issue === 'CAPTURE_FULLY_REFUNDED')) {
          throw new Error('Cette transaction a déjà été entièrement remboursée');
        }

        if (errorDetails.some((detail: any) => detail.issue === 'AMOUNT_MISMATCH' || detail.issue === 'INVALID_CURRENCY_CODE')) {
          throw new Error('Le montant ou la devise du remboursement est invalide');
        }
        if (errorDetails.some((detail: any) => detail.issue === 'DUPLICATE_INVOICE_ID')) {
          throw new Error('Un remboursement avec cet identifiant existe déjà');
        }
        if (errorDetails.some((detail: any) => detail.issue === 'MAX_NUMBER_OF_REFUNDS_EXCEEDED')) {
          throw new Error('Le nombre maximum de remboursements pour cette transaction a été atteint');
        }
      }

      if (errorResponse.name === 'RESOURCE_NOT_FOUND') {
        throw new Error('La transaction à rembourser est introuvable');
      }

      throw new Error(
        errorResponse.message ||
        error.message ||
        'Erreur lors du remboursement'
      );
    }
  }
}
