import { PayPalClient } from './paypalClient';
import { PayPalPaymentService } from './paypalPaymentService';
import { PayPalRefundService } from './paypalRefundService';
import { PayPalWebhookService } from './paypalWebhookService';
import { PayPalPartnerService } from './paypalPartnerService';

/**
 * Façade PayPal — délègue aux modules spécialisés.
 *
 * Les consumers (paymentController, paymentService) continuent d'appeler
 * `PayPalService.xxx` comme avant. Chaque module sous-jacent a une responsabilité
 * claire (SRP) et peut être testé / remplacé indépendamment.
 */
export class PayPalService {
  // Low-level client
  static getAccessToken = PayPalClient.getAccessToken;
  static checkPaymentStatus = PayPalClient.checkPaymentStatus;
  static getCaptureDetails = PayPalClient.getCaptureDetails;
  static verifyWebhookSignature = PayPalClient.verifyWebhookSignature;

  // Payment flow
  static createDirectPayment = PayPalPaymentService.createDirectPayment;
  static captureConnectedPayment = PayPalPaymentService.captureConnectedPayment;

  // Refund flow
  static refundConnectedPayment = PayPalRefundService.refundConnectedPayment;

  // Webhook dispatcher
  static handleWebhook = PayPalWebhookService.handleWebhook;

  // Onboarding vendeur (Connected Path / Partner Referrals)
  static createOnboardingLink = PayPalPartnerService.createOnboardingLink;
  static completeOnboarding = PayPalPartnerService.completeOnboarding;
  static refreshSellerStatus = PayPalPartnerService.refreshSellerStatus;
  static forgetSellerAccount = PayPalPartnerService.forgetSellerAccount;

  /**
   * Alias legacy pour compatibilité. Utiliser checkPaymentStatus directement.
   */
  static getPaymentStatus = PayPalClient.checkPaymentStatus;
}
