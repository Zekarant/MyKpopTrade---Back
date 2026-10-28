import mongoose, { Schema, Document } from 'mongoose';

export interface IFaq extends Document {
  question: string;
  answer: string;
  category: string;
  order: number;
  isPublished: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const FaqSchema: Schema = new Schema({
  question: {
    type: String,
    required: true,
    maxlength: 300,
    trim: true
  },
  answer: {
    type: String,
    required: true,
    maxlength: 5000,
    trim: true
  },
  category: {
    type: String,
    default: 'general',
    trim: true
  },
  order: {
    type: Number,
    default: 0
  },
  isPublished: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

FaqSchema.index({ isPublished: 1, category: 1, order: 1 });

export default mongoose.model<IFaq>('Faq', FaqSchema);
