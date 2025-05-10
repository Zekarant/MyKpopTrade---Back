import axios from 'axios';
import { paymentConfig } from '../../../config/paymentConfig';
import { EncryptionService } from '../../../commons/utils/encryptionService';
import { GdprLogger } from '../../../commons/utils/gdprLogger';
import logger from '../../../commons/utils/logger';

/**
 * Service d'intégration avec PayPal
 */
export class PayPalService {
  private static baseUrl = paymentConfig.paypal.mode === 'live'
    ? 'https://api.paypal.com'
    : 'https://api.sandbox.paypal.com';
  
  /**
   * Obtient un token d'accès pour l'API PayPal
   */
  private static async getAccessToken(): Promise<string> {
    try {
      const auth = Buffer.from(
        `${paymentConfig.paypal.clientId}:${paymentConfig.paypal.clientSecret}`
      ).toString('base64');
      
      const response = await axios({
        method: 'post',
        url: `${this.baseUrl}/v1/oauth2/token`,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${auth}`
        },
        data: 'grant_type=client_credentials'
      });
      
      return response.data.access_token;
    } catch (error) {
      logger.error('Erreur lors de l\'obtention du token PayPal', { error });
      throw new Error('Impossible d\'authentifier avec PayPal');
    }
  }
  
  /**
   * Crée une commande PayPal
   */
  static async createPayment({
    amount,
    currency = 'EUR',
    description,
    returnUrl,
    cancelUrl,
    userId,
    metadata
  }: {
    amount: number;
    currency?: string;
    description: string;
    returnUrl: string;
    cancelUrl: string;
    userId: string;
    metadata: any;
  }) {
    try {
      const accessToken = await this.getAccessToken();
      
      // Créer un identifiant unique pour cette transaction
      const transactionId = EncryptionService.generateTransactionHash(
        userId, 
        Date.now()
      );
      
      // Valider le montant
      if (amount < paymentConfig.platform.minPaymentAmount || 
          amount > paymentConfig.platform.maxPaymentAmount) {
        throw new Error(`Le montant doit être entre ${paymentConfig.platform.minPaymentAmount} et ${paymentConfig.platform.maxPaymentAmount}`);
      }
      
      // Créer la demande de paiement PayPal
      const payloadData = {
        intent: 'CAPTURE',
        purchase_units: [{
          reference_id: transactionId,
          description: description,
          amount: {
            currency_code: currency,
            value: amount.toFixed(2)
          },
          // Stockage sécurisé des métadonnées
          custom_id: transactionId
        }],
        application_context: {
          brand_name: 'MyKpopTrade',
          landing_page: 'BILLING',
          shipping_preference: 'NO_SHIPPING', // Pas d'adresse de livraison nécessaire
          user_action: 'PAY_NOW',
          return_url: returnUrl,
          cancel_url: cancelUrl
        }
      };
      
      // Effectuer la requête à l'API PayPal
      const response = await axios({
        method: 'post',
        url: `${this.baseUrl}/v2/checkout/orders`,
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        data: payloadData
      });
      
      // Journaliser l'événement (compatible RGPD)
      GdprLogger.logPaymentAction('create_paypal_order', {
        orderId: response.data.id,
        amount,
        currency
      }, userId);
      
      // Trouver le lien pour rediriger l'utilisateur
      const approvalUrl = response.data.links.find(
        (link: any) => link.rel === 'approve'
      ).href;
      
      return {
        id: response.data.id,
        status: response.data.status,
        approvalUrl,
        transactionId
      };
    } catch (error) {
      // Journaliser l'erreur de manière sécurisée
      GdprLogger.logPaymentError(error, userId, { amount, currency });
      throw error;
    }
  }
  
  /**
   * Capture un paiement PayPal après approbation
   */
  static async capturePayment(orderId: string, userId: string) {
    try {
      const accessToken = await this.getAccessToken();
      
      const response = await axios({
        method: 'post',
        url: `${this.baseUrl}/v2/checkout/orders/${orderId}/capture`,
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      });
      
      // Vérifier le succès de la capture
      if (response.data.status === 'COMPLETED') {
        const captureDetails = response.data.purchase_units[0].payments.captures[0];
        
        // Journaliser la capture réussie
        GdprLogger.logPaymentAction('capture_paypal_payment', {
          orderId,
          captureId: captureDetails.id,
          status: response.data.status
        }, userId);
        
        return {
          status: response.data.status,
          captureId: captureDetails.id,
          amount: captureDetails.amount,
          captureStatus: captureDetails.status,
          payer: response.data.payer
        };
      } else {
        throw new Error(`La capture a échoué avec le statut: ${response.data.status}`);
      }
    } catch (error) {
      GdprLogger.logPaymentError(error, userId, { orderId });
      throw error;
    }
  }
  
  /**
   * Récupère les détails d'un paiement
   */
  static async getPaymentDetails(orderId: string, userId: string) {
    try {
      const accessToken = await this.getAccessToken();
      
      const response = await axios({
        method: 'get',
        url: `${this.baseUrl}/v2/checkout/orders/${orderId}`,
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      });
      
      // Journaliser la consultation (important pour l'audit RGPD)
      GdprLogger.logPaymentDataAccess('check_payment_details', orderId, userId);
      
      return response.data;
    } catch (error) {
      logger.error('Erreur lors de la récupération des détails du paiement', {
        error, orderId
      });
      throw error;
    }
  }
  
  /**
   * Effectue un remboursement
   */
  static async refundPayment(
    captureId: string,
    amount: number | null,
    reason: string | null,
    userId: string
  ) {
    try {
      const accessToken = await this.getAccessToken();
      
      // Préparer les données de remboursement
      let data: any = {};
      
      // Si un montant est spécifié pour un remboursement partiel
      if (amount !== null) {
        // Récupérer d'abord la devise utilisée pour la capture
        const captureDetails = await axios({
          method: 'get',
          url: `${this.baseUrl}/v2/payments/captures/${captureId}`,
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          }
        });
        
        data.amount = {
          value: amount.toFixed(2),
          currency_code: captureDetails.data.amount.currency_code
        };
      }
      
      // Ajouter une raison si fournie
      if (reason) {
        data.note_to_payer = reason.substring(0, 255); // Limitation PayPal
      }
      
      // Effectuer le remboursement
      const response = await axios({
        method: 'post',
        url: `${this.baseUrl}/v2/payments/captures/${captureId}/refund`,
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        data: Object.keys(data).length ? data : {}
      });
      
      // Journaliser le remboursement
      GdprLogger.logPaymentAction('refund_paypal_payment', {
        captureId,
        refundId: response.data.id,
        amount: amount || 'total',
        status: response.data.status
      }, userId);
      
      return {
        id: response.data.id,
        status: response.data.status,
        refundAmount: response.data.amount,
        createdAt: new Date().toISOString()
      };
    } catch (error) {
      GdprLogger.logPaymentError(error, userId, { captureId, amount });
      throw error;
    }
  }
  
  /**
   * Valide le webhook PayPal
   */
  static async validateWebhook(headers: any, body: string): Promise<boolean> {
    try {
      const accessToken = await this.getAccessToken();
      
      const response = await axios({
        method: 'post',
        url: `${this.baseUrl}/v1/notifications/verify-webhook-signature`,
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        data: {
          auth_algo: headers['paypal-auth-algo'],
          cert_url: headers['paypal-cert-url'],
          transmission_id: headers['paypal-transmission-id'],
          transmission_sig: headers['paypal-transmission-sig'],
          transmission_time: headers['paypal-transmission-time'],
          webhook_id: paymentConfig.paypal.webhookId,
          webhook_event: JSON.parse(body)
        }
      });
      
      return response.data.verification_status === 'SUCCESS';
    } catch (error) {
      logger.error('Erreur lors de la validation du webhook PayPal', { error });
      return false;
    }
  }
}