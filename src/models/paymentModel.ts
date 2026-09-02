import mongoose, { Schema, Document } from 'mongoose';

/**
 * Note sur les champs `*Encrypted`.
 *
 * Ce modèle embarquait un chiffrement AES des identifiants de paiement, retiré
 * car il était à la fois mort et cassé :
 * - `getPaymentIntentId()` / `setPaymentIntentId()` n'avaient aucun appelant ;
 * - la clé de repli en dur (`'yourSecretKeyForEncryption32Bytes'`, présente dans
 *   le dépôt public) fait 33 octets alors qu'AES-256 en exige 32 : tout appel
 *   levait « Invalid key length » ;
 * - `PAYMENT_ENCRYPTION_KEY` n'était pas déclarée dans le schéma de configuration,
 *   donc rien ne signalait l'absence de clé au démarrage.
 *
 * Les champs `paymentIntentEncrypted` et `captureIdEncrypted` sont conservés :
 * `src/scripts/dataRetention.ts` les remet à `undefined` lors de la purge, et des
 * documents existants peuvent les porter. Ils ne sont plus jamais écrits.
 *
 * Si le chiffrement au repos de ces identifiants redevient un besoin, passer par
 * `EncryptionService` (clé validée au démarrage, IV aléatoire) plutôt que par une
 * quatrième implémentation locale d'AES.
 */

export interface IPayment extends Document {
  product: mongoose.Types.ObjectId;
  buyer: mongoose.Types.ObjectId;
  seller: mongoose.Types.ObjectId;
  amount: number;
  currency: string;
  platformFee: number;
  paymentIntentId: string;
  /**
   * Champs hérités d'une tentative de chiffrement des identifiants de paiement,
   * jamais aboutie : voir le commentaire au-dessus du schéma. Conservés pour
   * rester compatible avec les documents existants et src/scripts/dataRetention.ts.
   */
  paymentIntentEncrypted?: string;
  captureId?: string;
  captureIdEncrypted?: string;
  status: 'pending' | 'completed' | 'failed' | 'refunded' | 'partially_refunded' | 'cancelled';
  paymentMethod: 'paypal' | 'stripe' | 'other';
  paymentType: 'direct' | 'platform';
  paymentMetadata?: string;
  ipAddress: string;
  userAgent: string;
  isAnonymized: boolean;
  completedAt?: Date;
  // Ajout des propriétés pour les remboursements
  approvalUrl?: string;
  stripeCheckoutSessionId?: string;
  stripePaymentIntentId?: string;
  stripeChargeId?: string;
  /** Commission plateforme prélevée en centimes (Stripe travaille en plus petite unité) */
  platformFeeCents?: number;
  refundAmount?: number;
  refundReason?: string;
  refundedAt?: Date;
  refundId?: string;
  /**
   * Total cumulé des remboursements effectués (en unité de la devise, ex EUR).
   * Indispensable pour valider les remboursements partiels successifs.
   */
  totalRefunded?: number;
  /**
   * Historique des remboursements, append-only. Permet de tracer chaque
   * opération (montant, motif, ID PayPal, date, source) pour les litiges et
   * les audits comptables.
   */
  refunds?: Array<{
    refundId: string;
    amount: number;
    currency: string;
    reason?: string;
    status: 'pending' | 'completed' | 'failed';
    initiatedBy?: mongoose.Types.ObjectId;
    initiatedAt: Date;
    settledAt?: Date;
  }>;
  createdAt: Date;
  updatedAt: Date;
  retentionExpiresAt?: Date; // Date d'expiration de la rétention des données
  anonymized: boolean;
  gdprRetentionDate?: Date;
  productAmount?: number;
  shippingAmount?: number;
  shippingMethod?: 'national' | 'worldwide' | 'localPickup';
  shippingAddress?: {
    recipientName: string;
    streetLine1: string;
    streetLine2?: string;
    postalCode: string;
    city: string;
    country: string;
    phone?: string;
  };
  shipment?: {
    carrier: string;
    trackingNumber: string;
    trackingUrl?: string;
    status: 'shipped' | 'delivered';
    shippedAt: Date;
    deliveredAt?: Date;
    estimatedDeliveryAt?: Date;
    lastTrackedAt?: Date;
    lastReminderAt?: Date;
    autoConfirmedAt?: Date;
    events?: Array<{
      status: string;
      description?: string;
      location?: string;
      occurredAt: Date;
      source: 'system' | 'seller' | 'buyer' | 'carrier';
    }>;
  };
}

const paymentSchema: Schema = new Schema({
  product: {
    type: Schema.Types.ObjectId,
    ref: 'Product',
    required: true
  },
  buyer: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  seller: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  amount: {
    type: Number,
    required: true
  },
  currency: {
    type: String,
    default: 'EUR',
    required: true
  },
  platformFee: {
    type: Number,
    default: 0
  },
  paymentIntentId: {
    type: String
  },
  paymentIntentEncrypted: {
    type: String
  },
  captureId: {
    type: String
  },
  captureIdEncrypted: {
    type: String
  },
  approvalUrl: {
    type: String
  },
  stripeCheckoutSessionId: {
    type: String,
    index: { sparse: true }
  },
  stripePaymentIntentId: {
    type: String,
    index: { sparse: true }
  },
  stripeChargeId: {
    type: String,
    index: { sparse: true }
  },
  platformFeeCents: {
    type: Number,
    default: 0,
    min: 0
  },
  status: {
    type: String,
    enum: ['pending', 'completed', 'failed', 'refunded', 'partially_refunded', 'cancelled'],
    default: 'pending'
  },
  paymentMethod: {
    type: String,
    enum: ['paypal', 'stripe', 'other'],
    default: 'paypal'
  },
  paymentType: {
    type: String,
    enum: ['direct', 'platform'],
    default: 'direct'
  },
  paymentMetadata: {
    type: String,
    select: false // Données cryptées, ne pas sélectionner par défaut
  },
  ipAddress: {
    type: String,
    select: false // Ne pas sélectionner par défaut pour protéger la vie privée
  },
  userAgent: {
    type: String,
    select: false // Ne pas sélectionner par défaut pour protéger la vie privée
  },
  isAnonymized: {
    type: Boolean,
    default: false
  },
  completedAt: {
    type: Date
  },
  // Champs ajoutés pour les remboursements
  refundAmount: {
    type: Number
  },
  refundReason: {
    type: String
  },
  refundedAt: {
    type: Date
  },
  refundId: {
    type: String
  },
  totalRefunded: {
    type: Number,
    default: 0,
    min: 0
  },
  refunds: {
    type: [new Schema({
      refundId: { type: String, required: true, trim: true },
      amount: { type: Number, required: true, min: 0 },
      currency: { type: String, required: true, trim: true, maxlength: 3 },
      reason: { type: String, trim: true, maxlength: 500 },
      status: { type: String, enum: ['pending', 'completed', 'failed'], required: true },
      initiatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
      initiatedAt: { type: Date, required: true, default: Date.now },
      settledAt: { type: Date }
    }, { _id: false })],
    default: []
  },
  retentionExpiresAt: {
    type: Date
  },
  anonymized: {
    type: Boolean,
    default: false
  },
  gdprRetentionDate: {
    type: Date,
    default: () => {
      const date = new Date();
      date.setFullYear(date.getFullYear() + 3); // 3 ans par défaut
      return date;
    }
  },
  productAmount: {
    type: Number,
    min: 0
  },
  shippingAmount: {
    type: Number,
    default: 0,
    min: 0
  },
  shippingMethod: {
    type: String,
    enum: ['national', 'worldwide', 'localPickup']
  },
  shippingAddress: {
    type: new Schema({
      recipientName: { type: String, required: true, trim: true, maxlength: 100 },
      streetLine1: { type: String, required: true, trim: true, maxlength: 200 },
      streetLine2: { type: String, trim: true, maxlength: 200 },
      postalCode: { type: String, required: true, trim: true, maxlength: 16 },
      city: { type: String, required: true, trim: true, maxlength: 100 },
      country: { type: String, required: true, trim: true, maxlength: 2, default: 'FR' },
      phone: { type: String, trim: true, maxlength: 32 }
    }, { _id: false }),
    default: undefined
  },
  shipment: {
    type: new Schema({
      carrier: { type: String, required: true, trim: true, maxlength: 50 },
      trackingNumber: { type: String, required: true, trim: true, maxlength: 100 },
      trackingUrl: { type: String, trim: true, maxlength: 500 },
      status: { type: String, enum: ['shipped', 'delivered'], required: true },
      shippedAt: { type: Date, required: true },
      deliveredAt: { type: Date },
      estimatedDeliveryAt: { type: Date },
      lastTrackedAt: { type: Date },
      lastReminderAt: { type: Date },
      autoConfirmedAt: { type: Date },
      events: {
        type: [new Schema({
          status: { type: String, required: true, trim: true, maxlength: 50 },
          description: { type: String, trim: true, maxlength: 300 },
          location: { type: String, trim: true, maxlength: 200 },
          occurredAt: { type: Date, required: true },
          source: { type: String, enum: ['system', 'seller', 'buyer', 'carrier'], required: true }
        }, { _id: false })],
        default: []
      }
    }, { _id: false }),
    default: undefined
  }
}, {
  timestamps: true
});

// Middleware pre-save pour définir la date d'expiration de la rétention
paymentSchema.pre('save', function(next) {
  if (!this.retentionExpiresAt) {
    // Fixer la rétention à 10 ans pour les transactions financières (obligation légale)
    const expirationDate = new Date();
    expirationDate.setFullYear(expirationDate.getFullYear() + 10);
    this.retentionExpiresAt = expirationDate;
  }
  next();
});

// Middleware pour masquer les données sensibles dans les réponses JSON
paymentSchema.methods.toJSON = function() {
  const obj = this.toObject();
  
  // Supprimer les données sensibles
  delete obj.ipAddress;
  delete obj.userAgent;
  delete obj.paymentMetadata;
  
  // Si anonymisé, supprimer encore plus de données
  if (obj.anonymized) {
    if (obj.buyerDetails) {
      obj.buyerDetails = "Anonymized";
    }
    
    if (obj.paypalEmail) {
      obj.paypalEmail = "anonymized@example.com";
    }
  }
  
  return obj;
};

export default mongoose.models.Payment || mongoose.model<IPayment>('Payment', paymentSchema);