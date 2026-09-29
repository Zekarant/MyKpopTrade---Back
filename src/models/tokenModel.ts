import mongoose, { Schema, Document } from 'mongoose';

export interface IRefreshToken extends Document {
  /**
   * Empreinte SHA-256 du jeton quand `hashed` vaut true. Les sessions ouvertes
   * avant le hachage portent le jeton en clair ; elles disparaissent d'elles-
   * mêmes au plus tard 7 jours après leur création (index TTL).
   *
   * Le champ garde son nom pour réutiliser l'index unique existant : un nouveau
   * champ sans valeur sur les anciens documents aurait heurté cet index.
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

export default mongoose.models.RefreshToken ||
  mongoose.model<IRefreshToken>('RefreshToken', RefreshTokenSchema);
