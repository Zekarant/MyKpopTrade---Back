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
  allowOffers: boolean;
  minOfferPercentage: number;
  isPayWhatYouWant: boolean;
  pwywMinPrice?: number;
  pwywMaxPrice?: number;
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
  allowOffers: {
    type: Boolean,
    default: false
  },
  minOfferPercentage: {
    type: Number,
    default: 50 // 50% du prix minimum par défaut
  },
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

export default mongoose.models.Product || mongoose.model<IProduct>('Product', ProductSchema);