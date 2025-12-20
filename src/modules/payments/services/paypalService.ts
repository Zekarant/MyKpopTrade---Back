import axios from 'axios';
import { paymentConfig } from '../../../config/paymentConfig';
import { EncryptionService } from '../../../commons/utils/encryptionService';
import { GdprLogger } from '../../../commons/utils/gdprLogger';
import logger from '../../../commons/utils/logger';
import Product from '../../../models/productModel';
import User from '../../../models/userModel';
import Payment from '../../../models/paymentModel';
import { NotificationService } from '../../notifications/services/notificationService';

/**
 * Service PayPal simplifié avec paiements directs
 */
export class PayPalService {
  // URL de base pour l'API PayPal
  private static apiBaseUrl = process.env.NODE_ENV === 'production'
    ? 'https://api.paypal.com'
    : 'https://api.sandbox.paypal.com';

  /**
   * Obtient un token d'accès pour l'API PayPal
   */
  static async getAccessToken(): Promise<string> {
    try {
      const clientId = process.env.PAYPAL_CLIENT_ID;
      const clientSecret = process.env.PAYPAL_CLIENT_SECRET;

      if (!clientId || !clientSecret) {
        throw new Error('Les identifiants PayPal ne sont pas configurés');
      }

      const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

      const response = await axios({
        method: 'post',
        url: `${this.apiBaseUrl}/v1/oauth2/token`,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${auth}`
        },
        data: 'grant_type=client_credentials'
      });

      return response.data.access_token;
    } catch (error) {
      logger.error('Erreur lors de l\'obtention du token d\'accès PayPal', {
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Crée un paiement direct pour un produit
   */
  static async createDirectPayment(
    productId: string,
    buyerId: string
  ): Promise<any> {
    try {
      // Récupérer les informations du produit et du vendeur
      const product = await Product.findById(productId);
      if (!product) {
        throw new Error('Produit non trouvé');
      }

      const seller = await User.findById(product.seller);
      if (!seller) {
        throw new Error('Vendeur non trouvé');
      }

      // Vérifier que le vendeur a configuré son email PayPal
      if (!seller.paypalEmail) {
        throw new Error('Le vendeur n\'a pas configuré son email PayPal');
      }

      // Déterminer le montant à payer : offre acceptée ou prix initial
      let amountToPay = product.price;
      // Si le produit est lié à une conversation de négociation, récupérer l'offre acceptée
      if (product.currentOffer && typeof product.currentOffer === 'number' && product.currentOffer > 0) {
        amountToPay = product.currentOffer;
      }
      const roundedPrice = parseFloat(amountToPay.toFixed(2));

      // Obtenir le token d'accès
      const accessToken = await this.getAccessToken();

      // Créer l'ordre PayPal
      const response = await axios({
        method: 'post',
        url: `${this.apiBaseUrl}/v2/checkout/orders`,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`
        },
        data: {
          intent: 'CAPTURE',
          purchase_units: [
            {
              amount: {
                currency_code: product.currency || 'EUR',
                value: roundedPrice.toString()
              },
              description: `Achat sur MyKpopTrade: ${product.title.substring(0, 100)}`,
              custom_id: productId,
              payee: {
                email_address: seller.paypalEmail
              }
            }
          ],
          application_context: {
            return_url: `${process.env.FRONTEND_URL}/payment/success?source=paypal`,
            cancel_url: `${process.env.FRONTEND_URL}/payment/cancel?source=paypal`,
            brand_name: 'MyKpopTrade',
            shipping_preference: 'NO_SHIPPING',
            user_action: 'PAY_NOW',
            locale: 'fr-FR'
          }
        }
      });

      // Créer l'enregistrement de paiement
      const payment = new Payment({
        product: productId,
        buyer: buyerId,
        seller: product.seller,
        amount: roundedPrice,
        platformFee: 0, // Pas de commission dans ce modèle
        currency: product.currency || 'EUR',
        paymentIntentId: response.data.id,
        status: 'pending',
        paymentMethod: 'paypal',
        paymentType: 'direct'
      });

      await payment.save();

      // Réserver le produit
      await Product.findByIdAndUpdate(productId, {
        isReserved: true,
        reservedFor: buyerId,
        reservedUntil: new Date(Date.now() + 60 * 60 * 1000) // 1 heure
      });

      // Trouver le lien d'approbation
      const approvalUrl = response.data.links.find(
        (link: any) => link.rel === 'approve'
      )?.href;

      return {
        orderId: response.data.id,
        approvalUrl,
        paymentId: payment._id,
        amount: roundedPrice,
        currency: product.currency || 'EUR'
      };
    } catch (error) {
      logger.error('Erreur lors de la création du paiement PayPal', {
        error: error instanceof Error ? error.message : String(error),
        productId
      });
      throw error;
    }
  }

  /**
   * Vérifie le statut d'un paiement
   */
  static async checkPaymentStatus(orderId: string): Promise<string> {
    try {
      const accessToken = await this.getAccessToken();

      const response = await axios({
        method: 'get',
        url: `${this.apiBaseUrl}/v2/checkout/orders/${orderId}`,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`
        }
      });

      return response.data.status;
    } catch (error) {
      logger.error('Erreur lors de la vérification du statut du paiement', {
        error: error instanceof Error ? error.message : String(error),
        orderId
      });
      throw error;
    }
  }

  /**
   * Capture un paiement avec le compte vendeur connecté
   */
  static async captureConnectedPayment(orderId: string, sellerId: string): Promise<any> {
    try {
      // Pour l'approche simplifiée, on utilise le token d'accès de l'application
      const accessToken = await this.getAccessToken();

      // Générer un ID de requête unique pour l'idempotence
      const requestId = `capture_${orderId}_${Date.now()}`;

      // Effectuer la capture avec le token d'accès
      const response = await axios({
        method: 'post',
        url: `${this.apiBaseUrl}/v2/checkout/orders/${orderId}/capture`,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          'PayPal-Request-Id': requestId
        }
      });

      // Vérifier la réponse
      if (response.data.status !== 'COMPLETED') {
        throw new Error(`La capture a échoué avec le statut: ${response.data.status}`);
      }

      // Extraire les informations de la capture
      const captureInfo = response.data.purchase_units[0]?.payments?.captures[0];
      if (!captureInfo) {
        throw new Error('Informations de capture introuvables dans la réponse PayPal');
      }

      return {
        status: response.data.status,
        captureId: captureInfo.id,
        amount: captureInfo.amount.value,
        currency: captureInfo.amount.currency_code
      };
    } catch (error) {
      logger.error('Erreur lors de la capture du paiement', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        orderId,
        sellerId: sellerId.substring(0, 5) + '...'
      });

      throw error;
    }
  }

  /**
   * Traite le webhook PayPal pour gérer les événements de paiement
   */
  static async handleWebhook(event: any): Promise<void> {
    try {
      // Traiter les différents types d'événements
      switch (event.event_type) {
        case 'CHECKOUT.ORDER.APPROVED':
        case 'PAYMENT.CAPTURE.COMPLETED':
          await this.handlePaymentCompleted(event);
          break;

        case 'PAYMENT.CAPTURE.REFUNDED':
          await this.handleRefund(event);
          break;

        case 'PAYMENT.CAPTURE.DENIED':
          await this.handleCaptureDenied(event);
          break;

        default:
          logger.debug('Type d\'événement webhook non traité', { eventType: event.event_type });
          break;
      }
    } catch (error) {
      logger.error('Erreur lors du traitement du webhook PayPal', {
        error: error instanceof Error ? error.message : String(error),
        eventType: event.event_type
      });
      throw error;
    }
  }

  /**
   * Traite les événements de paiement/capture complété
   */
  private static async handlePaymentCompleted(event: any): Promise<void> {
    try {
      const resource = event.resource;
      const orderId = resource.id ||
        resource.supplementary_data?.related_ids?.order_id ||
        resource.invoice_id ||
        resource.custom_id;

      if (!orderId) {
        logger.warn('Impossible de déterminer l\'orderId dans l\'événement de capture', {
          resourceId: resource.id
        });
        return;
      }

      // Rechercher le paiement correspondant
      const payment = await Payment.findOne({ paymentIntentId: orderId });

      if (!payment) {
        logger.warn('Aucun paiement trouvé pour l\'orderId', { orderId });
        return;
      }

      // Mettre à jour le statut du paiement
      if (payment.status !== 'completed') {
        payment.status = 'completed';
        payment.completedAt = new Date();

        // Si c'est un événement de capture, stocker l'ID de capture
        if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED' && resource.id) {
          payment.captureId = resource.id;
        }

        await payment.save();

        // Mettre à jour le statut du produit
        await Product.findByIdAndUpdate(payment.product, {
          isAvailable: false,
          isSold: true,
          soldAt: new Date(),
          soldTo: payment.buyer
        });

        // Notifier le vendeur
        await NotificationService.createNotification({
          recipientId: payment.seller,
          type: 'system',
          title: 'Nouveau paiement reçu',
          content: `Un acheteur a payé ${payment.amount} ${payment.currency} pour votre produit.`,
          link: `/account/sales/${payment._id}`,
          data: {
            paymentId: payment._id,
            productId: payment.product,
            amount: payment.amount,
            currency: payment.currency
          }
        });
      }
    } catch (error) {
      logger.error('Erreur lors du traitement de l\'événement de paiement complété', { error });
      throw error;
    }
  }

  /**
   * Traite les événements de remboursement
   */
  private static async handleRefund(event: any): Promise<void> {
    try {
      const resource = event.resource;
      const captureId = resource.links.find((link: any) => link.rel === 'up')?.href.split('/').pop();

      if (!captureId) {
        logger.warn('Impossible de déterminer le captureId dans l\'événement de remboursement', {
          resourceId: resource.id
        });
        return;
      }

      // Rechercher le paiement correspondant
      const payment = await Payment.findOne({ captureId });

      if (!payment) {
        logger.warn('Aucun paiement trouvé pour le captureId', { captureId });
        return;
      }

      // Déterminer s'il s'agit d'un remboursement partiel ou complet
      const refundAmount = parseFloat(resource.amount.value);
      const isPartialRefund = refundAmount < payment.amount;

      // Mettre à jour le statut du paiement
      payment.status = isPartialRefund ? 'partially_refunded' : 'refunded';
      payment.refundAmount = refundAmount;
      payment.refundedAt = new Date();
      payment.refundId = resource.id;
      await payment.save();

      // Si c'est un remboursement complet, rendre le produit à nouveau disponible
      if (!isPartialRefund) {
        await Product.findByIdAndUpdate(payment.product, {
          isAvailable: true,
          isSold: false,
          soldAt: null,
          soldTo: null
        });
      }

      // Notifier l'acheteur
      await NotificationService.createNotification({
        recipientId: payment.buyer,
        type: 'system',
        title: isPartialRefund ? 'Remboursement partiel reçu' : 'Remboursement complet reçu',
        content: `Vous avez été remboursé de ${refundAmount} ${resource.amount.currency_code} pour votre achat.`,
        link: `/account/purchases/${payment._id}`,
        data: {
          paymentId: payment._id,
          productId: payment.product,
          refundAmount,
          currency: resource.amount.currency_code,
          isRefund: true
        }
      });
    } catch (error) {
      logger.error('Erreur lors du traitement de l\'événement de remboursement', { error });
      throw error;
    }
  }

  /**
   * Traite les événements de capture refusée
   */
  private static async handleCaptureDenied(event: any): Promise<void> {
    try {
      const resource = event.resource;
      const orderId = resource.supplementary_data?.related_ids?.order_id ||
        resource.invoice_id ||
        resource.custom_id;

      if (!orderId) {
        logger.warn('Impossible de déterminer l\'orderId dans l\'événement de refus', {
          resourceId: resource.id
        });
        return;
      }

      // Rechercher le paiement correspondant
      const payment = await Payment.findOne({ paymentIntentId: orderId });

      if (!payment) {
        logger.warn('Aucun paiement trouvé pour l\'orderId', { orderId });
        return;
      }

      // Mettre à jour le statut du paiement
      payment.status = 'failed';
      await payment.save();

      // Rendre le produit à nouveau disponible
      await Product.findByIdAndUpdate(payment.product, {
        isAvailable: true,
        isReserved: false,
        reservedFor: null
      });
    } catch (error) {
      logger.error('Erreur lors du traitement de l\'événement de capture refusée', { error });
      throw error;
    }
  }

  /**
   * Vérifie le statut d'un ordre PayPal
   * @param orderId L'ID de l'ordre PayPal
   * @param sellerId L'ID du vendeur (optionnel, pour compatibilité avec l'ancien code)
   * @returns Le statut de l'ordre PayPal
   */
  static async getPaymentStatus(orderId: string, sellerId?: string): Promise<string> {
    try {
      // Utiliser directement checkPaymentStatus pour la compatibilité avec l'ancien code
      return await this.checkPaymentStatus(orderId);
    } catch (error) {
      logger.error('Erreur lors de la vérification du statut du paiement', {
        error: error instanceof Error ? error.message : String(error),
        orderId,
        sellerId: sellerId ? sellerId.substring(0, 5) + '...' : undefined
      });
      throw error;
    }
  }

  /**
   * Effectue un remboursement pour un paiement capturé
   * @param captureId ID de la capture PayPal
   * @param amount Montant à rembourser (null pour remboursement complet)
   * @param reason Raison du remboursement
   * @param sellerId ID du vendeur
   * @returns Informations du remboursement
   */
  static async refundConnectedPayment(
    captureId: string,
    amount: number | null,
    reason: string,
    sellerId: string
  ): Promise<{ id: string; status: string; createdAt: Date }> {
    try {
      // Masquer partiellement le captureId pour la journalisation
      const maskedCaptureId = captureId.substring(0, 5) + '...';

      GdprLogger.logPaymentAction('remboursement_preparation', {
        captureId: maskedCaptureId,
        isPartial: amount !== null
      }, sellerId);

      // Récupérer l'utilisateur pour ses informations
      const seller = await User.findById(sellerId);
      if (!seller) {
        throw new Error('Vendeur non trouvé');
      }

      // Obtenir un token d'accès - soit du vendeur, soit global pour l'application
      let accessToken: string;

      // Essayer d'utiliser les tokens du vendeur s'ils existent
      if (seller.paypalTokens && seller.paypalTokens.accessToken) {
        accessToken = seller.paypalTokens.accessToken;
        logger.debug('Utilisation du token d\'accès du vendeur', {
          sellerId: sellerId.substring(0, 5) + '...'
        });
      } else {
        // Sinon, utiliser le token d'accès global de l'application
        accessToken = await this.getAccessToken();
        logger.debug('Utilisation du token d\'accès de l\'application', {
          sellerId: sellerId.substring(0, 5) + '...'
        });
      }

      // Récupérer les détails de la capture pour connaître la devise
      const captureDetails = await this.getCaptureDetails(captureId, accessToken);

      // Journaliser les détails pour le débogage (sans informations sensibles)
      logger.info('Préparation d\'un remboursement ' + (amount !== null ? 'partiel' : 'complet'), {
        captureId: maskedCaptureId,
        amount: amount,
        currency: captureDetails.currency,
        maxRefundable: captureDetails.amount
      });

      // Préparer le corps de la requête selon qu'il s'agit d'un remboursement complet ou partiel
      let requestBody: any = {};

      if (amount !== null) {
        // Remboursement partiel - Formater correctement le montant
        // Conversion du montant en string avec 2 décimales exactement
        const formattedAmount = parseFloat(amount.toString()).toFixed(2);

        requestBody = {
          amount: {
            value: formattedAmount,
            currency_code: captureDetails.currency
          },
          note_to_payer: reason || 'Remboursement partiel'
        };

        // Vérifier que le montant de remboursement n'est pas supérieur au montant capturé
        if (parseFloat(formattedAmount) > captureDetails.amount) {
          throw new Error(`Le montant du remboursement (${formattedAmount} ${captureDetails.currency}) est supérieur au montant capturé (${captureDetails.amount} ${captureDetails.currency})`);
        }
      } else {
        // Remboursement complet - Ne pas spécifier de montant
        requestBody = {
          note_to_payer: reason || 'Remboursement complet'
        };
      }

      // Configurer les en-têtes avec l'authentification OAuth et l'ID de requête unique
      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
        'PayPal-Request-Id': `refund_${captureId}_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`,
        'Prefer': 'return=representation'  // Garantir que PayPal renvoie les détails complets
      };

      // Journaliser la requête pour le débogage (sans données sensibles)
      logger.debug('Corps de la requête de remboursement', {
        isPartial: amount !== null,
        captureId: maskedCaptureId,
        requestBody: JSON.stringify(requestBody)
      });

      // Effectuer la demande de remboursement
      const response = await axios.post(
        `${this.apiBaseUrl}/v2/payments/captures/${captureId}/refund`,
        requestBody,
        { headers }
      );

      // Journaliser la réussite
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
      // Améliorer la journalisation des erreurs
      const errorResponse = error.response?.data || {};
      const errorDetails = errorResponse.details || [];

      GdprLogger.logPaymentError(error, sellerId, {
        captureId: captureId,
        statusCode: error.response?.status,
        errorName: errorResponse.name
      });

      // Gestion spécifique des erreurs courantes de PayPal
      if (errorResponse.name === 'UNPROCESSABLE_ENTITY') {
        // Vérifier si la capture a déjà été entièrement remboursée
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

      // Lancer une erreur avec des détails
      throw new Error(
        errorResponse.message ||
        error.message ||
        'Erreur lors du remboursement'
      );
    }
  }

  /**
   * Récupère les détails d'une capture de paiement
   */
  public static async getCaptureDetails(captureId: string, accessToken: string): Promise<{
    amount: number;
    currency: string;
    status: string;
  }> {
    try {
      // Configurer les en-têtes avec l'authentification OAuth
      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      };

      // Effectuer la demande pour obtenir les détails de la capture
      const response = await axios.get(
        `${this.apiBaseUrl}/v2/payments/captures/${captureId}`,
        { headers }
      );

      // Extraire et analyser les détails de la capture
      const captureData = response.data;
      const value = parseFloat(captureData.amount.value);
      const currency = captureData.amount.currency_code;

      return {
        amount: value,
        currency: currency,
        status: captureData.status
      };
    } catch (error: any) {
      logger.error('Erreur lors de la récupération des détails de la capture', {
        captureId: captureId.substring(0, 5) + '...',
        error: error.message,
        statusCode: error.response?.status,
        details: error.response?.data
      });
      throw new Error('Impossible de récupérer les détails de la capture PayPal');
    }
  }
  /**
   * Génère l'URL pour connecter un compte vendeur
   * @param sellerId ID du vendeur
   * @returns URL de connexion PayPal
   */
  static generateConnectUrl(sellerId: string): string {
    // Pour la solution simplifiée, cette méthode n'est plus utilisée
    // Mais on la maintient pour la compatibilité
    const baseUrl = process.env.API_URL || "http://localhost:3000/api";
    const redirectUri = encodeURIComponent(`${baseUrl}/connect/paypal/callback`);
    const state = encodeURIComponent(sellerId);

    return `${this.apiBaseUrl}/connect/oauth2/authorize?flowEntry=static&client_id=${process.env.PAYPAL_CLIENT_ID}&response_type=code&scope=email%20payments&redirect_uri=${redirectUri}&state=${state}`;
  }

  /**
   * Traite le callback de connexion PayPal
   * @param code Code d'autorisation
   * @param sellerId ID du vendeur
   * @returns Succès ou échec de la connexion
   */
  static async handleConnectCallback(code: string, sellerId: string): Promise<boolean> {
    // Pour la solution simplifiée, cette méthode n'est plus vraiment utilisée
    // Mais on la maintient pour la compatibilité
    try {
      // Simuler une connexion réussie
      const user = await User.findById(sellerId);
      if (!user) return false;

      // Mise à jour fictive pour la compatibilité
      user.paypalEmail = user.email;  // Utiliser simplement l'email de l'utilisateur
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

  /**
   * Capture un paiement approuvé
   * @param orderId ID de l'ordre PayPal à capturer
   * @returns Résultat de la capture
   */
  static async capturePayment(orderId: string): Promise<any> {
    try {
      // Obtenir un token d'accès
      const accessToken = await this.getAccessToken();

      // Générer un ID de requête unique pour l'idempotence
      const requestId = `capture_${orderId}_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;

      // Journaliser avant la tentative de capture
      logger.debug('Tentative de capture d\'un paiement', {
        orderId: orderId.substring(0, 5) + '...',
        requestId
      });

      // Effectuer la capture avec le token d'accès
      const response = await axios({
        method: 'post',
        url: `${this.apiBaseUrl}/v2/checkout/orders/${orderId}/capture`,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          'PayPal-Request-Id': requestId,
          'Prefer': 'return=representation'  // Pour obtenir une réponse détaillée
        }
      });

      // Vérifier la réponse
      if (response.data.status !== 'COMPLETED') {
        throw new Error(`La capture a échoué avec le statut: ${response.data.status}`);
      }

      // Journaliser la réussite de la capture
      logger.info('Paiement capturé avec succès', {
        orderId: orderId.substring(0, 5) + '...',
        status: response.data.status
      });

      // Extraire les informations de la capture
      const captureInfo = response.data.purchase_units[0]?.payments?.captures[0];
      if (!captureInfo) {
        throw new Error('Informations de capture introuvables dans la réponse PayPal');
      }

      return {
        status: response.data.status,
        captureId: captureInfo.id,
        amount: captureInfo.amount.value,
        currency: captureInfo.amount.currency_code,
        createTime: captureInfo.create_time,
        updateTime: captureInfo.update_time,
        finalCapture: captureInfo.final_capture || true
      };
    } catch (error) {
      logger.error('Erreur lors de la capture du paiement', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        orderId: orderId.substring(0, 5) + '...'
      });

      // Journaliser la réponse de PayPal si elle existe pour faciliter le débogage
      // if (error.response && error.response.data) {
      //   logger.error('Détails de l\'erreur PayPal lors de la capture', {
      //     status: error.response.status,
      //     name: error.response.data.name,
      //     message: error.response.data.message,
      //     details: JSON.stringify(error.response.data.details)
      //   });

      //   // Si l'erreur est que l'ordre est déjà capturé, nous pouvons récupérer les informations
      //   if (error.response.data.name === 'ORDER_ALREADY_CAPTURED') {
      //     try {
      //       // Récupérer les détails de l'ordre pour obtenir la capture
      //       const orderDetails = await axios({
      //         method: 'get',
      //         url: `${this.apiBaseUrl}/v2/checkout/orders/${orderId}`,
      //         headers: {
      //           'Content-Type': 'application/json',
      //           'Authorization': `Bearer ${accessToken}`
      //         }
      //       });

      //       const captureInfo = orderDetails.data.purchase_units[0]?.payments?.captures[0];

      //       if (captureInfo) {
      //         logger.info('Ordre déjà capturé, récupération des informations', {
      //           orderId: orderId.substring(0, 5) + '...',
      //           captureId: captureInfo.id
      //         });

      //         return {
      //           status: 'COMPLETED',
      //           captureId: captureInfo.id,
      //           amount: captureInfo.amount.value,
      //           currency: captureInfo.amount.currency_code,
      //           createTime: captureInfo.create_time,
      //           updateTime: captureInfo.update_time,
      //           alreadyCaptured: true
      //         };
      //       }
      //     } catch (secondError) {
      //       // Ignorer cette erreur secondaire, nous allons de toute façon relancer l'erreur originale
      //       logger.warn('Erreur lors de la récupération des détails de l\'ordre déjà capturé', {
      //         error: secondError instanceof Error ? secondError.message : String(secondError),
      //         orderId: orderId.substring(0, 5) + '...'
      //       });
      //     }
      //   }
      // }

      throw error;
    }
  }
}