import mongoose, { Schema, Document } from 'mongoose';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

export interface IUser extends Document {
  username: string;
  email: string;
  password: string;
  isActive: boolean;
  profilePicture: string;
  profileBanner?: string;
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt?: Date;
  privacyPolicyAccepted: boolean;
  privacyPolicyAcceptedAt?: Date;
  dataProcessingConsent: boolean;
  dataProcessingConsentAt?: Date;
  marketingConsent: boolean;
  marketingConsentAt?: Date;
  scheduledForDeletion: boolean;
  scheduledDeletionDate?: Date;
  anonymized: boolean;
  comparePassword(candidatePassword: string): Promise<boolean>;
  isEmailVerified: boolean;
  isPhoneVerified: boolean;
  accountStatus: 'active' | 'suspended' | 'deleted';
  role: 'user' | 'moderator' | 'admin';
  lastLogin?: Date;
  bio?: string;
  location?: string;
  preferences?: {
    kpopGroups?: string[];
    allowDirectMessages?: boolean;
  };
  socialLinks?: {
    instagram?: string;
    twitter?: string;
    discord?: string;
  };
  statistics?: {
    totalSales: number;
    totalPurchases: number;
    totalListings: number;
    memberSince: Date;
    lastActive: Date;
    averageRating: number;
    totalRatings: number;
  };
  socialAuth?: {
    google?: {
      id: string;
      email: string;
    };
    facebook?: {
      id: string;
      email: string;
    };
    discord?: {
      id: string;
      email: string;
    };
  };
  emailVerificationToken?: string;
  emailVerificationExpires?: Date;
  passwordResetToken?: string;
  passwordResetExpires?: Date;
  phoneVerificationCode?: string;
  phoneVerificationExpires?: Date;
  comparePassword(candidatePassword: string): Promise<boolean>;
  generateVerificationToken(): string;
  generatePasswordResetToken(): string;
  favorites?: mongoose.Types.ObjectId[];
  isIdentityVerified?: boolean;
  identityVerifiedAt?: Date;
  verificationLevel: 'none' | 'basic' | 'advanced' | 'complete';
  paypalEmail?: string;
  isSellerVerified?: boolean;
  sellerRating?: number;
  
  followedGroups?: mongoose.Types.ObjectId[];
  followedGroupsCount?: number;
}

const UserSchema: Schema = new Schema({
  username: {
    type: String,
    required: [true, 'Veuillez fournir un nom d\'utilisateur'],
    unique: true,
    trim: true,
    maxlength: [50, 'Le nom d\'utilisateur ne peut pas dépasser 50 caractères']
  },
  email: {
    type: String,
    required: [true, 'Veuillez fournir un email'],
    unique: true,
    match: [/^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/, 'Veuillez fournir un email valide']
  },
  password: {
    type: String,
    required: [true, 'Veuillez fournir un mot de passe'],
    minlength: [8, 'Le mot de passe doit comporter au moins 8 caractères'],
    select: false // Ne pas inclure par défaut dans les requêtes
  },
  role: {
    type: String,
    enum: ['user', 'admin'],
    default: 'user'
  },
  isActive: {
    type: Boolean,
    default: true
  },
  profilePicture: {
    type: String,
    default: 'https://mykpoptrade.com/images/avatar-default.png'
  },
  profileBanner: {
    type: String,
    default: null
  },
  paypalEmail: {
    type: String,
    validate: {
      validator: function(v: string) {
        return /^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/.test(v);
      },
      message: 'Veuillez fournir un email PayPal valide'
    }
  },
  // Champs RGPD
  privacyPolicyAccepted: {
    type: Boolean,
    default: false
  },
  privacyPolicyAcceptedAt: {
    type: Date
  },
  dataProcessingConsent: {
    type: Boolean,
    default: false
  },
  dataProcessingConsentAt: {
    type: Date
  },
  marketingConsent: {
    type: Boolean,
    default: false
  },
  marketingConsentAt: {
    type: Date
  },
  scheduledForDeletion: {
    type: Boolean,
    default: false
  },
  scheduledDeletionDate: {
    type: Date
  },
  anonymized: {
    type: Boolean,
    default: false
  },
  lastLoginAt: {
    type: Date
  },
  isEmailVerified: {
    type: Boolean,
    default: false
  },
  isPhoneVerified: {
    type: Boolean,
    default: false
  },
  accountStatus: {
    type: String,
    enum: ['active', 'suspended', 'deleted'],
    default: 'active'
  },
  lastLogin: {
    type: Date
  },
  bio: {
    type: String,
    maxlength: 500
  },
  location: {
    type: String,
    maxlength: 100
  },
  preferences: {
    kpopGroups: {
      type: [String],
      default: []
    },
    allowDirectMessages: {
      type: Boolean,
      default: true
    }
  },
  socialLinks: {
    instagram: String,
    twitter: String,
    discord: String
  },
  statistics: {
    totalSales: {
      type: Number,
      default: 0
    },
    totalPurchases: {
      type: Number,
      default: 0
    },
    totalListings: {
      type: Number,
      default: 0
    },
    memberSince: {
      type: Date,
      default: Date.now
    },
    lastActive: {
      type: Date,
      default: Date.now
    },
    averageRating: {
      type: Number,
      default: 0
    },
    totalRatings: {
      type: Number,
      default: 0
    }
  },
  socialAuth: {
    google: {
      id: String,
      email: String
    },
    facebook: {
      id: String,
      email: String
    },
    discord: {
      id: String,
      email: String
    }
  },
  emailVerificationToken: String,
  emailVerificationExpires: Date,
  passwordResetToken: String,
  passwordResetExpires: Date,
  phoneVerificationCode: String,
  phoneVerificationExpires: Date,
  favorites: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product'
  }],
  isIdentityVerified: {
    type: Boolean,
    default: false
  },
  identityVerifiedAt: Date,
  verificationLevel: {
    type: String,
    enum: ['none', 'basic', 'advanced', 'complete'],
    default: 'none'
  },
  isSellerVerified: {
    type: Boolean,
    default: false
  },
  sellerRating: {
    type: Number,
    min: 0,
    max: 5,
    default: 0
  },

  followedGroups: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'KpopGroup',
    default: []
  }],
  followedGroupsCount: {
    type: Number,
    default: 0
  },
  
}, {
  timestamps: true
});

// Middleware de pré-sauvegarde pour le hachage du mot de passe
UserSchema.pre('save', async function(next) {
  if (!this.isModified('password')) {
    return next();
  }
  
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password as string, salt);
    next();
  } catch (error: any) {
    next(error);
  }
});

// Modification de la méthode comparePassword
UserSchema.methods.comparePassword = async function(candidatePassword: string): Promise<boolean> {
  try {
    // Vérifier si le mot de passe est défini
    if (!this.password) {
      throw new Error('Le mot de passe utilisateur n\'est pas disponible pour la comparaison');
    }
    
    return await bcrypt.compare(candidatePassword, this.password);
  } catch (error) {
    console.error('Erreur lors de la comparaison du mot de passe:', error);
    throw new Error(error instanceof Error ? error.message : String(error));
  }
};

UserSchema.methods.generateVerificationToken = function(): string {
  const token = crypto.randomBytes(32).toString('hex');
  this.emailVerificationToken = token;
  this.emailVerificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 heures
  return token;
};

UserSchema.methods.generatePasswordResetToken = function(): string {
  const token = crypto.randomBytes(32).toString('hex');
  this.passwordResetToken = token;
  this.passwordResetExpires = new Date(Date.now() + 1 * 60 * 60 * 1000); // 1 heure
  return token;
};

export default mongoose.models.User || mongoose.model<IUser>('User', UserSchema);