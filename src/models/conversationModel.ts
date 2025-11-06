import mongoose, { Schema, Document } from 'mongoose';

// Interface pour l'historique des offres
export interface IOfferHistory {
  offeredBy: mongoose.Types.ObjectId;
  amount: number;
  offerType: 'initial' | 'counter';
  status: 'pending' | 'accepted' | 'rejected' | 'expired';
  message?: string;
  createdAt: Date;
  respondedAt?: Date;
}

export interface IConversation extends Document {
  participants: mongoose.Types.ObjectId[];
  productId?: mongoose.Types.ObjectId;
  lastMessage?: mongoose.Types.ObjectId;
  lastMessageAt: Date;
  isActive: boolean;
  type: 'general' | 'product_inquiry' | 'negotiation' | 'pay_what_you_want';
  status: 'open' | 'closed' | 'archived';
  createdBy: mongoose.Types.ObjectId;
  title?: string;
  deletedBy: mongoose.Types.ObjectId[];
  archivedBy: mongoose.Types.ObjectId[];
  favoritedBy: mongoose.Types.ObjectId[];
  negotiation?: {
    initialPrice: number;
    currentOffer: number;
    counterOffer?: number;
    status: 'pending' | 'accepted' | 'rejected' | 'expired' | 'completed';
    expiresAt?: Date;
  };
  payWhatYouWant?: {
    minimumPrice: number;
    maximumPrice?: number;
    proposedPrice?: number;
    status: 'pending' | 'accepted' | 'rejected';
  };
  offerHistory: IOfferHistory[];
  createdAt: Date;
  updatedAt: Date;
}

const ConversationSchema: Schema = new Schema({
  participants: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  }],
  productId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    index: true
  },
  lastMessage: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Message'
  },
  lastMessageAt: {
    type: Date,
    default: Date.now
  },
  isActive: {
    type: Boolean,
    default: true
  },
  type: {
    type: String,
    enum: ['general', 'product_inquiry', 'negotiation', 'pay_what_you_want'],
    default: 'general'
  },
  status: {
    type: String,
    enum: ['open', 'closed', 'archived'],
    default: 'open'
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  title: {
    type: String,
    trim: true
  },
  deletedBy: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: []
  }],
  archivedBy: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: []
  }],
  favoritedBy: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: []
  }],
  negotiation: {
    initialPrice: {
      type: Number
    },
    currentOffer: {
      type: Number
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
    }
  },
  payWhatYouWant: {
    minimumPrice: {
      type: Number
    },
    maximumPrice: {
      type: Number
    },
    proposedPrice: {
      type: Number
    },
    status: {
      type: String,
      enum: ['pending', 'accepted', 'rejected'],
      default: 'pending'
    }
  },
  offerHistory: [{
    offeredBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    amount: {
      type: Number,
      required: true
    },
    offerType: {
      type: String,
      enum: ['initial', 'counter'],
      required: true
    },
    status: {
      type: String,
      enum: ['pending', 'accepted', 'rejected', 'expired'],
      default: 'pending'
    },
    message: {
      type: String
    },
    createdAt: {
      type: Date,
      default: Date.now
    },
    respondedAt: {
      type: Date
    }
  }]
}, {
  timestamps: true
});

// Indexes pour optimiser les performances
ConversationSchema.index({ participants: 1 });
ConversationSchema.index({ lastMessageAt: -1 });
ConversationSchema.index({ createdAt: -1 });
ConversationSchema.index({ 'negotiation.status': 1, 'negotiation.expiresAt': 1 });
ConversationSchema.index({ deletedBy: 1 });
ConversationSchema.index({ archivedBy: 1 });
ConversationSchema.index({ favoritedBy: 1 });

export default mongoose.models.Conversation || mongoose.model<IConversation>('Conversation', ConversationSchema);