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
  images: string[];  // URLs des images
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

export default mongoose.models.Product || mongoose.model<IProduct>('Product', ProductSchema);