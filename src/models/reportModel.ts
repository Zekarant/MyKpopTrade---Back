import mongoose, { Schema, Document } from 'mongoose';

export interface IReport extends Document {
  reporter: mongoose.Types.ObjectId;
  targetType: 'rating' | 'product';
  targetId: mongoose.Types.ObjectId;
  reason: string;
  details?: string;
  status: 'pending' | 'reviewed' | 'resolved' | 'rejected';
  adminNotes?: string;
  createdAt: Date;
  updatedAt: Date;
  resolvedAt?: Date;
}

const ReportSchema: Schema = new Schema({
  reporter: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  targetType: {
    type: String,
    required: true,
    enum: ['rating', 'product']
  },
  targetId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    refPath: 'targetType'
  },
  reason: {
    type: String,
    required: true,
    enum: [
      'inappropriate_content',
      'offensive_language',
      'false_information',
      'spam',
      'fraud',
      'copyright_violation',
      'other'
    ]
  },
  details: {
    type: String,
    maxlength: 500
  },
  status: {
    type: String,
    required: true,
    enum: ['pending', 'reviewed', 'resolved', 'rejected'],
    default: 'pending'
  },
  adminNotes: {
    type: String,
    maxlength: 500
  },
  resolvedAt: {
    type: Date
  }
}, {
  timestamps: true
});

// Empêcher les doublons de signalements par le même utilisateur
ReportSchema.index({ reporter: 1, targetType: 1, targetId: 1 }, { unique: true });

export default mongoose.models.Report || mongoose.model<IReport>('Report', ReportSchema);