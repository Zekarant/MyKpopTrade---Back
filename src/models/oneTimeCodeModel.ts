import mongoose, { Schema, Document } from 'mongoose';

/**
 * Usages d'un code à usage unique ; chaque code ne vaut que pour son usage.
 * - `oauth_login` : fin de connexion OAuth, échangé contre les jetons de session ;
 * - `social_link` : ticket qui lance la liaison d'un compte Google/Discord.
 */
export const ONE_TIME_CODE_PURPOSES = ['oauth_login', 'social_link'] as const;
export type OneTimeCodePurpose = (typeof ONE_TIME_CODE_PURPOSES)[number];

export interface IOneTimeCode extends Document {
  /** Empreinte SHA-256 du code. */
  codeHash: string;
  purpose: OneTimeCodePurpose;
  userId: mongoose.Types.ObjectId;
  expiresAt: Date;
}

const OneTimeCodeSchema: Schema = new Schema({
  codeHash: {
    type: String,
    required: true,
    unique: true
  },
  purpose: {
    type: String,
    enum: ONE_TIME_CODE_PURPOSES,
    required: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  expiresAt: {
    type: Date,
    required: true,
    expires: 0
  }
});

export default (mongoose.models.OneTimeCode as mongoose.Model<IOneTimeCode>) ||
  mongoose.model<IOneTimeCode>('OneTimeCode', OneTimeCodeSchema);
