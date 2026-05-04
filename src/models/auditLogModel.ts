import mongoose, { Schema, Document } from 'mongoose';

export interface IAuditLog extends Document {
  admin: mongoose.Types.ObjectId;
  action: string;
  targetType: 'user' | 'product' | 'post' | 'report' | 'verification' | 'system';
  targetId?: mongoose.Types.ObjectId;
  details?: string;
  metadata?: Record<string, any>;
  createdAt: Date;
}

const auditLogSchema = new Schema<IAuditLog>({
  admin: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  action: { type: String, required: true },
  targetType: { type: String, enum: ['user', 'product', 'post', 'report', 'verification', 'system'], required: true },
  targetId: { type: Schema.Types.ObjectId },
  details: { type: String },
  metadata: { type: Schema.Types.Mixed }
}, {
  timestamps: { createdAt: true, updatedAt: false }
});

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ admin: 1, createdAt: -1 });
auditLogSchema.index({ targetType: 1, createdAt: -1 });

export default mongoose.model<IAuditLog>('AuditLog', auditLogSchema);
