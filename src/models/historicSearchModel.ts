import mongoose, { Document, Schema } from 'mongoose';

export interface ISearchHistory extends Document {
  userId: mongoose.Types.ObjectId;
  query: string;
  filters: {
    groups?: string[];
    members?: string[];
    albums?: string[];
    priceRange?: {
      min?: number;
      max?: number;
    };
    condition?: string[];
    type?: string;
    albumType?: string;
    era?: string;
    company?: string;
  };
  resultCount: number;
  lastSearched: Date;
  searchCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const SearchHistorySchema = new Schema<ISearchHistory>({
  userId: { 
    type: Schema.Types.ObjectId, 
    ref: 'User',
    required: true,
    index: true
  },
  query: { 
    type: String, 
    required: true,
    lowercase: true,
    trim: true
  },
  filters: {
    groups: [{ type: String }],
    members: [{ type: String }],
    albums: [{ type: String }],
    priceRange: {
      min: { type: Number },
      max: { type: Number }
    },
    condition: [{ type: String }],
    type: { type: String },
    albumType: { type: String },
    era: { type: String },
    company: { type: String }
  },
  resultCount: { type: Number, required: true },
  lastSearched: { 
    type: Date, 
    default: Date.now,
    index: true
  },
  searchCount: { type: Number, default: 1 }
}, {
  timestamps: true
});

// Index composé pour optimiser les requêtes d'historique
SearchHistorySchema.index({ userId: 1, lastSearched: -1 });
SearchHistorySchema.index({ userId: 1, query: 1 }, { unique: true });

export default mongoose.model<ISearchHistory>('SearchHistory', SearchHistorySchema);