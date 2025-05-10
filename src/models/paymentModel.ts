import mongoose, { Schema, Document } from 'mongoose';

export interface IPayment extends Document {
  // Identifiants nécessaires pour associer le paiement
  buyer: mongoose.Types.ObjectId;
  seller: mongoose.Types.ObjectId;
  product: mongoose.Types.ObjectId;
  conversation?: mongoose.Types.ObjectId;
  
  // Données financières
  amount: number;
  currency: string;
  platformFee?: number;
  
  // Données PayPal
  paymentIntentId: string;    // PayPal Order ID
  captureId?: string;         // PayPal Capture ID
  refundId?: string;          // PayPal Refund ID, si remboursé
  
  // Statut du paiement
  status: 'pending' | 'completed' | 'failed' | 'refunded' | 'disputed';
  
  // Dates pour l'audit
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
  
  // Données de traçabilité (RGPD)
  ipAddress?: string;         // Anonymisé après 30 jours
  userAgent?: string;         // Anonymisé après 30 jours
  
  // Données chiffrées (conformes RGPD)
  paymentMetadata?: string;   // Métadonnées chiffrées
  
  // Pour faciliter la gestion du droit à l'oubli
  isAnonymized: boolean;      // Si les données personnelles ont été anonymisées
}

const PaymentSchema: Schema = new Schema({
  buyer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  seller: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true,
    index: true
  },
  conversation: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Conversation'
  },
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  currency: {
    type: String,
    required: true,
    enum: ['EUR', 'USD', 'KRW', 'JPY', 'GBP'],
    default: 'EUR'
  },
  platformFee: {
    type: Number,
    min: 0
  },
  paymentIntentId: {
    type: String,
    required: true
  },
  captureId: {
    type: String
  },
  refundId: {
    type: String
  },
  status: {
    type: String,
    required: true,
    enum: ['pending', 'completed', 'failed', 'refunded', 'disputed'],
    default: 'pending',
    index: true
  },
  completedAt: {
    type: Date
  },
  paymentMetadata: {
    type: String
  },
  ipAddress: {
    type: String
  },
  userAgent: {
    type: String
  },
  isAnonymized: {
    type: Boolean,
    default: false,
    index: true
  }
}, {
  timestamps: true
});

// Index pour les requêtes fréquentes
PaymentSchema.index({ buyer: 1, status: 1 });
PaymentSchema.index({ seller: 1, status: 1 });
PaymentSchema.index({ createdAt: -1 });

export default mongoose.model<IPayment>('Payment', PaymentSchema);