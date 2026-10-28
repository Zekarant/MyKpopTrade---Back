import mongoose, { Schema, Document } from 'mongoose';

/**
 * Blocage d'un membre par un autre. Collection dédiée plutôt qu'un tableau
 * sur l'utilisateur : la liste d'un membre n'est pas bornée et la question
 * « l'un a-t-il bloqué l'autre ? » se pose sur chaque interaction.
 */
export interface IBlock extends Document {
  blocker: mongoose.Types.ObjectId;
  blocked: mongoose.Types.ObjectId;
  createdAt: Date;
}

const BlockSchema = new Schema<IBlock>(
  {
    blocker: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    blocked: { type: Schema.Types.ObjectId, ref: 'User', required: true }
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Un seul blocage par couple orienté. Sert aussi les deux sens de la
// vérification (chaque branche du $or fixe les deux champs) et, par son
// préfixe, la liste des membres bloqués par quelqu'un.
BlockSchema.index({ blocker: 1, blocked: 1 }, { unique: true });

export default (mongoose.models.Block as mongoose.Model<IBlock>) || mongoose.model<IBlock>('Block', BlockSchema);
