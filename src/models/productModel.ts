import mongoose, { Schema, Document } from 'mongoose';

/**
 * Analyse IA de modération, déclenchée quand un mot-clé suspect est détecté
 * dans le titre ou la description (`suspectKeywords.ts`). Consultative sur le
 * fond (l'admin garde la main), mais `suspect: true` met l'annonce en pause
 * automatiquement (`isAvailable = false`) le temps de la revue.
 */
export interface IProductModerationFlag {
  suspect: boolean;
  confidence: 'low' | 'medium' | 'high';
  reasoning: string;
  categories: string[];
  matchedKeywords: string[];
  keywordsVersion: string;
  policyVersion: string;
  model: string;
  /** Fournisseur IA ayant produit l'analyse (mistral | gemini). */
  provider: string;
  analyzedAt: Date;
  reviewedBy?: mongoose.Types.ObjectId;
  reviewedAt?: Date;
  reviewDecision?: 'approved' | 'rejected';
}

export interface IProduct extends Document {
  seller: mongoose.Types.ObjectId;
  title: string;
  description: string;
  price: number;
  currency: string;
  condition: 'new' | 'likeNew' | 'good' | 'fair' | 'poor';
  category: string;
  type: 'photocard' | 'album' | 'merch' | 'other';
  kpopGroup: string;
  kpopMember?: string;
  albumName?: string;
  images: string[];
  isAvailable: boolean;
  moderationFlag?: IProductModerationFlag;
  isReserved: boolean;
  isSold: boolean; // Nouveau champ
  soldAt?: Date; // Nouveau champ
  soldTo?: mongoose.Types.ObjectId; // Nouveau champ
  reservedFor?: mongoose.Types.ObjectId;
  shippingOptions: {
    worldwide: boolean;
    nationalOnly: boolean;
    localPickup: boolean;
    nationalCost?: number;
    worldwideCost?: number;
    /** @deprecated remplacé par nationalCost/worldwideCost — lu en fallback pour les anciens produits */
    shippingCost?: number;
  };
  createdAt: Date;
  updatedAt: Date;
  views: number;
  favorites: number;
  // Champs pour les offres/négociations
  allowOffers: boolean;
  minOfferPercentage: number;
  negotiations?: {
    buyer: mongoose.Types.ObjectId;
    initialOffer: number;
    currentOffer: number;
    counterOffer?: number;
    status: 'pending' | 'accepted' | 'rejected' | 'expired' | 'completed';
    expiresAt?: Date;
    conversationId: mongoose.Types.ObjectId;
    createdAt: Date;
    updatedAt: Date;
  }[];
  // Champs pour PWYW
  isPayWhatYouWant: boolean;
  pwywMinPrice?: number;
  pwywMaxPrice?: number;
  pwywOffers?: {
    buyer: mongoose.Types.ObjectId;
    proposedPrice: number;
    status: 'pending' | 'accepted' | 'rejected';
    conversationId: mongoose.Types.ObjectId;
    createdAt: Date;
  }[];
}

const ProductSchema: Schema = new Schema({
  seller: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  title: {
    type: String,
    required: true,
    maxlength: 100
  },
  description: {
    type: String,
    required: true,
    maxlength: 1000
  },
  price: {
    type: Number,
    required: true,
    min: 0
  },
  currency: {
    type: String,
    default: 'EUR',
    enum: ['EUR', 'USD', 'KRW', 'JPY', 'GBP']
  },
  condition: {
    type: String,
    required: true,
    enum: ['new', 'likeNew', 'good', 'fair', 'poor']
  },
  category: {
    type: String,
    required: true
  },
  type: {
    type: String,
    required: true,
    enum: ['photocard', 'album', 'merch', 'other']
  },
  kpopGroup: {
    type: String,
    required: true
  },
  kpopMember: {
    type: String
  },
  albumName: {
    type: String
  },
  images: {
    type: [String],
    required: true,
    validate: {
      validator: function(v: string[]) {
        return v && v.length > 0 && v.length <= 10;
      },
      message: 'Un produit doit avoir entre 1 et 10 images'
    }
  },
  isAvailable: {
    type: Boolean,
    default: true
  },
  moderationFlag: {
    type: new Schema({
      suspect: { type: Boolean, required: true },
      confidence: { type: String, enum: ['low', 'medium', 'high'], required: true },
      reasoning: { type: String, required: true, maxlength: 500 },
      categories: [{ type: String, maxlength: 50 }],
      matchedKeywords: [{ type: String, maxlength: 100 }],
      keywordsVersion: { type: String, required: true },
      policyVersion: { type: String, required: true },
      model: { type: String, required: true },
      provider: { type: String, required: true },
      analyzedAt: { type: Date, required: true },
      reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      reviewedAt: { type: Date },
      reviewDecision: { type: String, enum: ['approved', 'rejected'] }
    }, { _id: false }),
    default: undefined
  },
  isReserved: {
    type: Boolean,
    default: false
  },
  isSold: {
    type: Boolean,
    default: false
  },
  soldAt: {
    type: Date
  },
  soldTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  reservedFor: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  shippingOptions: {
    worldwide: {
      type: Boolean,
      default: false
    },
    nationalOnly: {
      type: Boolean,
      default: true
    },
    localPickup: {
      type: Boolean,
      default: false
    },
    nationalCost: {
      type: Number,
      min: 0
    },
    worldwideCost: {
      type: Number,
      min: 0
    },
    shippingCost: {
      type: Number,
      min: 0
    }
  },
  // Configuration des offres et négociations
  allowOffers: {
    type: Boolean,
    default: false
  },
  minOfferPercentage: {
    type: Number,
  },
  negotiations: [{
    buyer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    initialOffer: {
      type: Number,
      required: true
    },
    currentOffer: {
      type: Number,
      required: true
    },
    counterOffer: {
      type: Number
    },
    status: {
      type: String,
      enum: ['pending', 'accepted', 'rejected', 'expired', 'completed'],
      default: 'pending'
    },
    expiresAt: {
      type: Date
    },
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Conversation'
    },
    createdAt: {
      type: Date,
      default: Date.now
    },
    updatedAt: {
      type: Date,
      default: Date.now
    }
  }],
  // Configuration du "Pay What You Want"
  isPayWhatYouWant: {
    type: Boolean,
    default: false
  },
  pwywMinPrice: {
    type: Number
  },
  pwywMaxPrice: {
    type: Number
  },
  pwywOffers: [{
    buyer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    proposedPrice: {
      type: Number,
      required: true
    },
    status: {
      type: String,
      enum: ['pending', 'accepted', 'rejected'],
      default: 'pending'
    },
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Conversation'
    },
    createdAt: {
      type: Date,
      default: Date.now
    }
  }],
  views: {
    type: Number,
    default: 0
  },
  favorites: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true
});

ProductSchema.index({ 
  title: 'text', 
  description: 'text',
  kpopGroup: 'text',
  kpopMember: 'text',
  albumName: 'text'
}, {
  weights: {
    title: 10,
    kpopGroup: 5,
    kpopMember: 5,
    albumName: 3,
    description: 1
  },
  name: 'product_text_index'
});

ProductSchema.index({ seller: 1, isAvailable: 1 });
ProductSchema.index({ kpopGroup: 1, isAvailable: 1 });
ProductSchema.index({ type: 1, isAvailable: 1 });
ProductSchema.index({ createdAt: -1 });
ProductSchema.index({ 'negotiations.buyer': 1, 'negotiations.status': 1 });
ProductSchema.index({ 'pwywOffers.buyer': 1, 'pwywOffers.status': 1 });

export default mongoose.models.Product || mongoose.model<IProduct>('Product', ProductSchema);