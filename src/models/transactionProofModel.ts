import mongoose, { Schema, Document } from 'mongoose';

export interface ITransactionProof extends Document {
  user: mongoose.Types.ObjectId;
  transaction?: mongoose.Types.ObjectId;
  type: 'sale' | 'purchase' | 'exchange';
  images: string[];
  description: string; 
  status: 'pending' | 'verified' | 'rejected';
  verifiedBy?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
  otherParty?: {
    username?: string;
    platform?: string;
    profileUrl?: string;
  };
}

const TransactionProofSchema: Schema = new Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  transaction: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Transaction'
  },
  type: {
    type: String,
    required: true,
    enum: ['sale', 'purchase', 'exchange']
  },
  images: {
    type: [String],
    required: true,
    validate: {
      validator: function(v: string[]) {
        return v && v.length > 0 && v.length <= 5;
      },
      message: 'Une preuve doit contenir entre 1 et 5 images'
    }
  },
  description: {
    type: String,
    required: true,
    maxlength: 500
  },
  status: {
    type: String,
    default: 'pending',
    enum: ['pending', 'verified', 'rejected']
  },
  verifiedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  otherParty: {
    username: String,
    platform: String,
    profileUrl: String
  }
}, {
  timestamps: true
});

export default mongoose.models.TransactionProof || mongoose.model<ITransactionProof>('TransactionProof', TransactionProofSchema);