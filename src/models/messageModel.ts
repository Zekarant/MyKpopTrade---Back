import mongoose, { Schema, Document } from 'mongoose';

export interface IMessage extends Document {
  conversation: mongoose.Types.ObjectId;
  sender: mongoose.Types.ObjectId;
  content: string;
  attachments?: string[];
  contentType: 'text' | 'system_notification' | 'offer' | 'counter_offer' | 'shipping_update';
  readBy: mongoose.Types.ObjectId[];
  metadata?: {
    offerAmount?: number;
    shippingStatus?: string;
    negotiationAction?: string;
  };
  isEncrypted: boolean;
  encryptionDetails?: {
    algorithm: string;
    iv: string;
  };
  isDeleted: boolean;
  deletedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const MessageSchema: Schema = new Schema({
  conversation: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Conversation',
    required: true,
    index: true
  },
  sender: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  content: {
    type: String,
    required: true,
    trim: true
  },
  attachments: [{
    type: String
  }],
  contentType: {
    type: String,
    enum: ['text', 'system_notification', 'offer', 'counter_offer', 'shipping_update'],
    default: 'text'
  },
  readBy: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  metadata: {
    offerAmount: Number,
    shippingStatus: String,
    negotiationAction: String
  },
  isEncrypted: {
    type: Boolean,
    default: false
  },
  encryptionDetails: {
    algorithm: String,
    iv: String
  },
  isDeleted: {
    type: Boolean,
    default: false
  },
  deletedAt: {
    type: Date
  }
}, {
  timestamps: true
});

// Indexes pour optimiser les performances et requêtes courantes
MessageSchema.index({ conversation: 1, createdAt: -1 });
MessageSchema.index({ sender: 1 });
MessageSchema.index({ isDeleted: 1 });
MessageSchema.index({ contentType: 1 });
MessageSchema.index({ createdAt: -1 });

export default mongoose.models.Message || mongoose.model<IMessage>('Message', MessageSchema);