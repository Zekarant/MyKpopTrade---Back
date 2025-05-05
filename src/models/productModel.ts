import mongoose, { Schema, Document } from 'mongoose';

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
  isReserved: boolean;
  reservedFor?: mongoose.Types.ObjectId;
  shippingOptions: {
    worldwide: boolean;
    nationalOnly: boolean;
    localPickup: boolean;
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
  isReserved: {
    type: Boolean,
    default: false
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
    shippingCost: {
      type: Number
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