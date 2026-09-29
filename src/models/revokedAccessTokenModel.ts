import mongoose, { Schema, Document } from 'mongoose';

/**
 * Jeton d'accès révoqué avant son expiration (déconnexion).
 *
 * En base plutôt qu'en mémoire : une liste en mémoire se vidait à chaque
 * redémarrage et n'était pas partagée entre plusieurs instances de l'API, ce
 * qui rendait un jeton « déconnecté » de nouveau utilisable.
 */
export interface IRevokedAccessToken extends Document {
  /** Empreinte SHA-256 du jeton. */
  tokenHash: string;
  /** Expiration du jeton : au-delà, il est refusé de toute façon. */
  expiresAt: Date;
}

const RevokedAccessTokenSchema: Schema = new Schema({
  tokenHash: {
    type: String,
    required: true,
    unique: true
  },
  expiresAt: {
    type: Date,
    required: true,
    // TTL : le document disparaît quand le jeton expire.
    expires: 0
  }
});

export default mongoose.models.RevokedAccessToken ||
  mongoose.model<IRevokedAccessToken>('RevokedAccessToken', RevokedAccessTokenSchema);
