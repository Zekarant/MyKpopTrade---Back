import mongoose, { Schema, Document } from 'mongoose';

export interface IFollow extends Document {
  follower: mongoose.Types.ObjectId;
  following: mongoose.Types.ObjectId;
  createdAt: Date;
}

const followSchema = new Schema<IFollow>(
  {
    follower: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    following: { type: Schema.Types.ObjectId, ref: 'User', required: true }
  },
  { timestamps: true }
);

// Un utilisateur ne peut follow qu'une seule fois
followSchema.index({ follower: 1, following: 1 }, { unique: true });
// Index pour retrouver rapidement les followers/following
followSchema.index({ following: 1 });
followSchema.index({ follower: 1 });

export default mongoose.model<IFollow>('Follow', followSchema);
