import mongoose, { Schema, Document } from 'mongoose';
import type { SavedSearchCriteria } from './validation';

/**
 * Clé de groupe des recherches sans filtre de groupe : elles peuvent
 * correspondre à n'importe quelle annonce, et doivent sortir du même index
 * que les recherches ciblant le groupe de l'annonce publiée.
 */
export const ANY_GROUP_KEY = '*';

export interface ISavedSearch extends Document {
  user: mongoose.Types.ObjectId;
  name: string;
  criteria: SavedSearchCriteria;
  alertsEnabled: boolean;
  /** `group:<id>` du catalogue, groupes en minuscules ou ANY_GROUP_KEY : premier tri indexé des alertes (cf. toGroupKeys). */
  groupKeys: string[];
  /** Annonces correspondantes pas encore notifiées, regroupées à la prochaine alerte. */
  pendingProductIds: mongoose.Types.ObjectId[];
  /** Présent tant que des annonces attendent : sert à la purge périodique. */
  pendingSince?: Date;
  lastNotifiedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const savedSearchSchema = new Schema<ISavedSearch>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, maxlength: 60 },
    // Validés par zod à l'entrée : stockés tels quels pour être rejoués à
    // l'identique par la recherche avancée.
    criteria: { type: Schema.Types.Mixed, required: true },
    alertsEnabled: { type: Boolean, default: true },
    groupKeys: { type: [String], select: false },
    pendingProductIds: { type: [Schema.Types.ObjectId], select: false },
    pendingSince: { type: Date, select: false },
    lastNotifiedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

savedSearchSchema.index({ user: 1, createdAt: -1 });
// Premier tri des alertes : recherches actives visant le groupe de l'annonce.
savedSearchSchema.index({ alertsEnabled: 1, groupKeys: 1 });
// Purge périodique des alertes regroupées.
savedSearchSchema.index({ pendingSince: 1 }, { sparse: true });

export default (mongoose.models.SavedSearch as mongoose.Model<ISavedSearch>) ||
  mongoose.model<ISavedSearch>('SavedSearch', savedSearchSchema);
