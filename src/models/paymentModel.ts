import mongoose, { Schema, Document } from 'mongoose';
import crypto from 'crypto';

// Clé de chiffrement pour les données sensibles (à placer dans les variables d'environnement en production)
const ENCRYPTION_KEY = process.env.PAYMENT_ENCRYPTION_KEY || 'yourSecretKeyForEncryption32Bytes';
const IV_LENGTH = 16; // Pour AES

// Fonction pour chiffrer les données sensibles
function encrypt(text: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return `${iv.toString('hex')}:${encrypted}`;
}

// Fonction pour déchiffrer les données sensibles
function decrypt(text: string): string {
  const [ivHex, encryptedHex] = text.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

export interface IPayment extends Document {
  product: mongoose.Types.ObjectId;
  buyer: mongoose.Types.ObjectId;
  seller: mongoose.Types.ObjectId;
  amount: number;
  currency: string;
  platformFee: number;
  paymentIntentId: string;
  paymentIntentEncrypted: string; // Champ chiffré
  getPaymentIntentId(): string; // Méthode pour récupérer la valeur déchiffrée
  setPaymentIntentId(value: string): void; // Méthode pour définir la valeur chiffrée
  captureId?: string;
  captureIdEncrypted?: string; // Champ chiffré
  status: 'pending' | 'completed' | 'failed' | 'refunded' | 'partially_refunded' | 'cancelled';
  paymentMethod: 'paypal' | 'stripe' | 'other';
  paymentType: 'direct' | 'platform';
  paymentMetadata?: string;
  ipAddress: string;
  userAgent: string;
  isAnonymized: boolean;
  completedAt?: Date;
  // Ajout des propriétés pour les remboursements
  refundAmount?: number;
  refundReason?: string;
  refundedAt?: Date;
  refundId?: string;
  createdAt: Date;
  updatedAt: Date;
  retentionExpiresAt?: Date; // Date d'expiration de la rétention des données
  anonymized: boolean;
  gdprRetentionDate?: Date;
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
  }
}, {
  timestamps: true
});

// Middleware pour chiffrer/déchiffrer les données sensibles
paymentSchema.methods.getPaymentIntentId = function(): string {
  if (this.paymentIntentEncrypted) {
    return decrypt(this.paymentIntentEncrypted);
  }
  return this.paymentIntentId;
};

paymentSchema.methods.setPaymentIntentId = function(value: string): void {
  this.paymentIntentId = value; // Conservé pour compatibilité
  this.paymentIntentEncrypted = encrypt(value);
};

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