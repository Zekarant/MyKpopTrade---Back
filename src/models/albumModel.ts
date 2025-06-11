import mongoose, { Document, Schema } from 'mongoose';

export interface IKpopAlbum extends Document {
  name: string;
  coverImage: string;
  artistId: mongoose.Types.ObjectId;
  artistName: string;

  spotifyId?: string;
  spotifyUrl?: string;
  releaseDate?: Date;
  totalTracks?: number;
  albumType?: string;
  discoverySource: string;
  lastScraped: Date;
  createdAt: Date;
  updatedAt: Date;
}

const KpopAlbumSchema = new Schema<IKpopAlbum>({
  name: { 
    type: String, 
    required: true,
    trim: true
  },
  coverImage: { 
    type: String, 
    required: true,
    default: '/images/albums/default-album.jpg'
  },
  artistId: { 
    type: Schema.Types.ObjectId, 
    ref: 'KpopGroup', 
    required: true
  },
  artistName: { 
    type: String, 
    required: true
  },
  spotifyId: { 
    type: String
  },
  spotifyUrl: { 
    type: String
  },
  releaseDate: { 
    type: Date, 
    default: null
  },
  totalTracks: { 
    type: Number, 
    default: 0,
    min: 1
  },
  albumType: { 
    type: String, 
    default: 'album',
    enum: ['album', 'single', 'ep', 'compilation']
  },
  discoverySource: { 
    type: String, 
    default: 'Spotify',
    enum: ['Spotify', 'Manual', 'User Submission']
  },
  lastScraped: { 
    type: Date, 
    default: Date.now
  }
}, {
  timestamps: true
});

KpopAlbumSchema.index({ name: 1 });
KpopAlbumSchema.index({ artistId: 1 });
KpopAlbumSchema.index({ artistName: 1 });
KpopAlbumSchema.index({ spotifyId: 1 }, { sparse: true, unique: true });
KpopAlbumSchema.index({ releaseDate: -1 });
KpopAlbumSchema.index({ lastScraped: 1 });
KpopAlbumSchema.index({ discoverySource: 1 });

KpopAlbumSchema.index({ artistId: 1, releaseDate: -1 });
KpopAlbumSchema.index({ artistName: 1, name: 1 }, { unique: true });
KpopAlbumSchema.index({ totalTracks: -1 });

KpopAlbumSchema.statics.findByArtist = function(artistId: string) {
  return this.find({ artistId }).sort({ releaseDate: -1 });
};

KpopAlbumSchema.statics.findRecent = function(limit: number = 50) {
  return this.find({})
    .sort({ releaseDate: -1 })
    .limit(limit)
    .populate('artistId', 'name profileImage');
};

KpopAlbumSchema.statics.findBySpotifyId = function(spotifyId: string) {
  return this.findOne({ spotifyId });
};

export default mongoose.model<IKpopAlbum>('KpopAlbum', KpopAlbumSchema);