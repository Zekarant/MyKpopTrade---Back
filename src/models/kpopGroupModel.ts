import mongoose, { Document, Schema } from 'mongoose';

export interface ISocialLinks {
  twitter?: string;
  instagram?: string;
  youtube?: string;
  spotify?: string;
  weverse?: string;
  tiktok?: string;
  lastfm?: string;
}

export interface IKpopGroup extends Document {
  name: string;
  profileImage: string;
  bannerImage?: string;
  socialLinks: ISocialLinks;
  tags: string[];
  genres: string[];
  discoverySource: string;
  lastScraped: Date;
  createdAt: Date;
  updatedAt: Date;
  followers?: mongoose.Types.ObjectId[];
  followersCount?: number;
  spotifyId?: string;
  spotifyPopularity?: number;
  spotifyFollowers?: number;
  invalidReason?: string;
  invalidatedAt?: Date;
}

const SocialLinksSchema = new Schema<ISocialLinks>({
  twitter: { type: String },
  instagram: { type: String },
  youtube: { type: String },
  spotify: { type: String },
  weverse: { type: String },
  tiktok: { type: String },
  lastfm: { type: String }
}, { _id: false });

const kpopGroupSchema = new Schema({
  name: { 
    type: String, 
    required: true,
    trim: true
  },
  profileImage: { 
    type: String, 
    required: true,
    default: '/images/groups/default-group.jpg'
  },
  bannerImage: { 
    type: String,
    default: '/images/groups/default-banner.jpg'
  },
  socialLinks: {
    type: SocialLinksSchema,
    default: () => ({})
  },
  tags: [{ 
    type: String,
    default: ['K-pop']
  }],
  genres: [{ 
    type: String,
    default: ['K-pop']
  }],
  discoverySource: { 
    type: String, 
    default: 'Manual',
    enum: ['Manual', 'Last.fm', 'User Submission']
  },
  lastScraped: { 
    type: Date, 
    default: Date.now
  },
  followers: [{
    type: Schema.Types.ObjectId,
    ref: 'User'
  }],
  followersCount: {
    type: Number,
    default: 0,
    min: 0
  },
  spotifyId: {
    type: String
  },
  spotifyPopularity: {
    type: Number,
    min: 0,
    max: 100
  },
  spotifyFollowers: {
    type: Number,
    min: 0
  },
  invalidReason: {
    type: String
  },
  invalidatedAt: {
    type: Date
  }
}, {
  timestamps: true
});

kpopGroupSchema.index({ name: 1 }, { unique: true });
kpopGroupSchema.index({ isActive: 1 });
kpopGroupSchema.index({ genres: 1 });
kpopGroupSchema.index({ followers: 1 });
kpopGroupSchema.index({ spotifyId: 1 }, { sparse: true, unique: true });
kpopGroupSchema.index({ parentGroup: 1 }, { sparse: true });

kpopGroupSchema.pre('save', function(next) {
  if (!this.tags || this.tags.length === 0) {
    this.tags = ['K-pop'];
  }
  
  if (!this.genres || this.genres.length === 0) {
    this.genres = ['K-pop'];
  }
  
  this.lastScraped = new Date();
  
  next();
});

kpopGroupSchema.statics.findPopular = function(limit: number = 50) {
  return this.find({ 
    isActive: true 
  })
  .sort({ 
    name: 1 
  })
  .limit(limit);
};

kpopGroupSchema.statics.findSubUnitsOf = function(parentGroupName: string) {
  return this.find({ 
    parentGroup: parentGroupName,
    isActive: true 
  }).sort({ name: 1 });
};

kpopGroupSchema.statics.searchGroups = function(query: string) {
  return this.find({
    $text: { $search: query },
    isActive: true
  }).sort({ 
    score: { $meta: 'textScore' }
  });
};

export default mongoose.model<IKpopGroup>('KpopGroup', kpopGroupSchema);