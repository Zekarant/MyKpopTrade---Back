import mongoose, { Schema, Document } from 'mongoose';

export interface IMessage extends Document {
  conversation: mongoose.Types.ObjectId;
  sender: mongoose.Types.ObjectId;
  content: string;
  attachments?: string[];
  contentType: 'text' | 'system_notification' | 'offer' | 'counter_offer' | 'shipping_update' | 'mixed';
  readBy: mongoose.Types.ObjectId[];
  isSystemMessage: boolean;
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
    enum: ['text', 'system_notification', 'offer', 'counter_offer', 'shipping_update', 'mixed'],
    default: 'text'
  },
  readBy: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  isSystemMessage: {
    type: Boolean,
    default: false
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