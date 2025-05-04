import mongoose, { Schema, Document } from 'mongoose';

export interface IConversation extends Document {
  participants: mongoose.Types.ObjectId[];
  productId?: mongoose.Types.ObjectId;
  lastMessageAt: Date;
  isActive: boolean;
  type: 'general' | 'product_inquiry' | 'negotiation' | 'pay_what_you_want';
  status: 'open' | 'closed' | 'archived';
  createdBy: mongoose.Types.ObjectId;
  title?: string;
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
  }
}, {
  timestamps: true
});

// Indexes pour optimiser les performances
ConversationSchema.index({ participants: 1 });
ConversationSchema.index({ lastMessageAt: -1 });
ConversationSchema.index({ createdAt: -1 });
ConversationSchema.index({ 'negotiation.status': 1, 'negotiation.expiresAt': 1 });

export default mongoose.models.Conversation || mongoose.model<IConversation>('Conversation', ConversationSchema);