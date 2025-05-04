import mongoose, { Schema, Document } from 'mongoose';

export interface IRating extends Document {
  reviewer: mongoose.Types.ObjectId;
  recipient: mongoose.Types.ObjectId;
  rating: number;
  review: string;
  transaction?: mongoose.Types.ObjectId;
  type: 'buyer' | 'seller';
  createdAt: Date;
  updatedAt: Date;
  isVerifiedPurchase: boolean;
  isHidden: boolean;
}

const RatingSchema: Schema = new Schema({
  reviewer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  recipient: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  rating: {
    type: Number,
    required: true,
    min: 1,
    max: 5
  },
  review: {
    type: String,
    required: true,
    maxlength: 500
  },
  transaction: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Transaction'
  },
  type: {
    type: String,
    required: true,
    enum: ['buyer', 'seller']
  },
  isVerifiedPurchase: {
    type: Boolean,
    default: false
  },
  isHidden: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

RatingSchema.pre('save', function(this: IRating, next) {
  if (this.reviewer.toString() === this.recipient.toString()) {
    const err = new Error('Un utilisateur ne peut pas s\'auto-évaluer');
    return next(err);
  }
  next();
});

RatingSchema.index({ reviewer: 1, transaction: 1 }, { unique: true });

export default mongoose.models.Rating || mongoose.model<IRating>('Rating', RatingSchema);