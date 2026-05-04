import mongoose, { Schema, Document } from 'mongoose';

export interface IPost extends Document {
  author: mongoose.Types.ObjectId;
  content: string;
  images?: string[];
  likes: mongoose.Types.ObjectId[];
  likesCount: number;
  repliesCount: number;
  parentPost?: mongoose.Types.ObjectId;
  isReply: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const PostSchema: Schema = new Schema({
  author: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  content: {
    type: String,
    required: true,
    maxlength: 1000,
    trim: true
  },
  images: {
    type: [String],
    default: [],
    validate: {
      validator: (v: string[]) => v.length <= 4,
      message: 'Maximum 4 images par post'
    }
  },
  likes: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  likesCount: {
    type: Number,
    default: 0
  },
  repliesCount: {
    type: Number,
    default: 0
  },
  parentPost: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Post',
    default: null
  },
  isReply: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

PostSchema.index({ createdAt: -1 });
PostSchema.index({ author: 1, createdAt: -1 });
PostSchema.index({ parentPost: 1, createdAt: -1 });

export default mongoose.model<IPost>('Post', PostSchema);
