import mongoose, { Schema, Document } from 'mongoose';

export interface IRefreshToken extends Document {
  /**
   * Empreinte SHA-256 du jeton quand `hashed` vaut true, sinon jeton en clair
   * (sessions antérieures au hachage, purgées par l'index TTL). Le nom est
   * conservé pour réutiliser l'index unique existant.
   */
  token: string;
  hashed?: boolean;
  userId: mongoose.Types.ObjectId;
  expiresAt: Date;
  /** Date à laquelle le jeton a été échangé contre un nouveau. */
  rotatedAt?: Date;
  createdAt: Date;
}

const RefreshTokenSchema: Schema = new Schema({
  token: {
    type: String,
    required: true,
    unique: true
  },
  hashed: {
    type: Boolean
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  expiresAt: {
    type: Date,
    required: true
  },
  rotatedAt: {
    type: Date
  },
  createdAt: {
    type: Date,
    default: Date.now,
    expires: '7d' // TTL index pour nettoyage automatique
  }
});

export default (mongoose.models.RefreshToken as mongoose.Model<IRefreshToken>) ||
  mongoose.model<IRefreshToken>('RefreshToken', RefreshTokenSchema);
