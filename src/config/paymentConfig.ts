import dotenv from 'dotenv';

dotenv.config();

/**
 * Configuration des systèmes de paiement
 */
export const paymentConfig = {
  // Configuration PayPal Complete Payments (Connected Path / PPCP)
  paypal: {
    mode: process.env.PAYPAL_MODE === 'live' ? 'live' : 'sandbox',
    clientId: process.env.PAYPAL_CLIENT_ID || '',
    clientSecret: process.env.PAYPAL_CLIENT_SECRET || '',
    webhookId: process.env.PAYPAL_WEBHOOK_ID || '',
    /**
     * Merchant ID du compte plateforme (l'API-caller). Sert de `partner_id`
     * dans l'URL « show seller status » et de `payee` des platform_fees.
     */
    partnerMerchantId: process.env.PAYPAL_PARTNER_MERCHANT_ID || '',
    /**
     * Build Notation code attribué par PayPal. Obligatoire dans le header
     * `PayPal-Partner-Attribution-Id` de tous les appels partenaires.
     */
    bnCode: process.env.PAYPAL_BN_CODE || 'MYKPOPTRADE_SP_PPCP',
    /**
     * Commission plateforme prélevée via `payment_instruction.platform_fees`.
     * 0 = aucune commission (phase beta, conforme au questionnaire d'onboarding
     * PayPal : « No platform commission during beta phase »).
     */
    platformFeePercent: parseFloat(process.env.PAYPAL_PLATFORM_FEE_PERCENT || '0'),
    returnUrl: process.env.PAYPAL_RETURN_URL || 'http://localhost:3000/payment/success',
    cancelUrl: process.env.PAYPAL_CANCEL_URL || 'http://localhost:3000/payment/cancel'
  },

  // Configuration Stripe Connect
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
    /** Pourcentage de commission plateforme (0 = pas de commission) */
    platformFeePercent: parseFloat(process.env.PLATFORM_FEE_PERCENT || '0')
  },
  
  // Configuration pour la conformité RGPD
  gdpr: {
    // Période avant anonymisation des données de contact (en jours)
    ipAnonymizationDays: 30,
    // Période de conservation des données de paiement actives (en mois)
    paymentDataRetentionMonths: 36,
    // Période avant anonymisation complète (en années)
    fullAnonymizationYears: 7
  },
  
  // Frais et limites de la plateforme
  platform: {
    // Frais de plateforme en pourcentage
    feePercentage: parseFloat(process.env.PLATFORM_FEE_PERCENTAGE || '5'),
    // Montant minimum pour effectuer un paiement
    minPaymentAmount: parseFloat(process.env.MIN_PAYMENT_AMOUNT || '1'),
    // Montant maximum pour effectuer un paiement
    maxPaymentAmount: parseFloat(process.env.MAX_PAYMENT_AMOUNT || '1000')
  }
};

// Vérifier que les configurations minimales sont présentes
export const validatePaymentConfig = () => {
  // Garde-fou : les identifiants live ne doivent jamais être joués depuis un
  // environnement de dev. Sans ce contrôle, un `.env` oublié sur PAYPAL_MODE=live
  // ferait passer de vraies transactions depuis un poste local.
  if (paymentConfig.paypal.mode === 'live' && process.env.NODE_ENV !== 'production') {
    throw new Error(
      'PAYPAL_MODE=live est interdit hors production. Utilisez PAYPAL_MODE=sandbox en développement.'
    );
  }

  if (process.env.NODE_ENV === 'production') {
    if (!paymentConfig.paypal.clientId || !paymentConfig.paypal.clientSecret) {
      throw new Error(
        'Configuration PayPal incomplète pour l\'environnement de production.'
      );
    }
    if (!paymentConfig.paypal.partnerMerchantId) {
      throw new Error(
        'PAYPAL_PARTNER_MERCHANT_ID est requis : le merchant ID de la plateforme identifie le partenaire dans les appels « show seller status » et les platform_fees.'
      );
    }
    if (!paymentConfig.paypal.webhookId) {
      throw new Error(
        'PAYPAL_WEBHOOK_ID est requis : sans lui, la signature des webhooks PayPal ne peut pas être vérifiée.'
      );
    }
    if (!paymentConfig.stripe.secretKey || !paymentConfig.stripe.webhookSecret) {
      throw new Error(
        'Configuration Stripe incomplète pour l\'environnement de production.'
      );
    }
  }
};