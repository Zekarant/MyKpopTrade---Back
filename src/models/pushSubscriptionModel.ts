import mongoose, { Schema, Document } from 'mongoose';

/**
 * Stocke un abonnement Web Push (PushSubscription standard) par utilisateur.
 * Un même utilisateur peut avoir plusieurs abonnements actifs (mobile +
 * desktop), d'où la clé d'unicité sur l'endpoint.
 */
export interface IPushSubscription extends Document {
  user: mongoose.Types.ObjectId;
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  userAgent?: string;
  createdAt: Date;
  lastUsedAt?: Date;
}

const PushSubscriptionSchema: Schema = new Schema({
  user: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  endpoint: {
    type: String,
    required: true,
    unique: true
  },
  keys: {
    p256dh: { type: String, required: true },
    auth: { type: String, required: true }
  },
  userAgent: { type: String, maxlength: 500 },
  lastUsedAt: { type: Date }
}, { timestamps: true });

export default mongoose.models.PushSubscription
  || mongoose.model<IPushSubscription>('PushSubscription', PushSubscriptionSchema);
