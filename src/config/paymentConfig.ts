import env from './env';

/**
 * Configuration des systèmes de paiement
 */
export const paymentConfig = {
  // Configuration PayPal Complete Payments (Connected Path / PPCP)
  paypal: {
    mode: env.PAYPAL_MODE,
    clientId: env.PAYPAL_CLIENT_ID || '',
    clientSecret: env.PAYPAL_CLIENT_SECRET || '',
    webhookId: env.PAYPAL_WEBHOOK_ID || '',
    /**
     * Merchant ID du compte plateforme (l'API-caller). Sert de `partner_id`
     * dans l'URL « show seller status » et de `payee` des platform_fees.
     */
    partnerMerchantId: env.PAYPAL_PARTNER_MERCHANT_ID || '',
    /**
     * Build Notation code attribué par PayPal. Obligatoire dans le header
     * `PayPal-Partner-Attribution-Id` de tous les appels partenaires.
     */
    bnCode: env.PAYPAL_BN_CODE,
    /**
     * Commission plateforme prélevée via `payment_instruction.platform_fees`.
     * 0 = aucune commission (phase beta, conforme au questionnaire d'onboarding
     * PayPal : « No platform commission during beta phase »).
     */
    platformFeePercent: env.PAYPAL_PLATFORM_FEE_PERCENT,
    returnUrl: env.PAYPAL_RETURN_URL,
    cancelUrl: env.PAYPAL_CANCEL_URL
  }
};
