import dotenv from 'dotenv';

dotenv.config();

/**
 * Configuration des systèmes de paiement
 */
export const paymentConfig = {
  // Configuration PayPal
  paypal: {
    mode: process.env.PAYPAL_MODE || 'sandbox', // 'sandbox' ou 'live'
    clientId: process.env.PAYPAL_CLIENT_ID || '',
    clientSecret: process.env.PAYPAL_CLIENT_SECRET || '',
    webhookId: process.env.PAYPAL_WEBHOOK_ID || '',
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
  if (process.env.NODE_ENV === 'production') {
    if (!paymentConfig.paypal.clientId || !paymentConfig.paypal.clientSecret) {
      throw new Error(
        'Configuration PayPal incomplète pour l\'environnement de production.'
      );
    }
    if (!paymentConfig.stripe.secretKey || !paymentConfig.stripe.webhookSecret) {
      throw new Error(
        'Configuration Stripe incomplète pour l\'environnement de production.'
      );
    }
  }
};