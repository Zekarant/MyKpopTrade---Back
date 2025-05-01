import mongoose, { Schema, Document } from 'mongoose';
import bcrypt from 'bcrypt';
import crypto from 'crypto';

export interface IUser extends Document {
  username: string;
  email: string;
  password: string;
  profilePicture?: string;
  phoneNumber?: string;
  isEmailVerified: boolean;
  isPhoneVerified: boolean;
  accountStatus: 'active' | 'suspended' | 'deleted';
  lastLogin?: Date;
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
}

const UserSchema: Schema = new Schema({
  username: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    minlength: 3,
    maxlength: 30
  },
  email: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true
  },
  password: {
    type: String,
    required: function(this: mongoose.Document & IUser): boolean {
      // Mot de passe requis sauf si authentification sociale
      return !this.socialAuth?.google && !this.socialAuth?.facebook && !this.socialAuth?.discord;
    },
    minlength: 8
  },
  profilePicture: {
    type: String
  },
  phoneNumber: {
    type: String
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
  phoneVerificationExpires: Date
}, {
  timestamps: true
});

// Hash le mot de passe avant de sauvegarder
UserSchema.pre('save', async function(next) {
  if (this.isModified('password')) {
    try {
      const salt = await bcrypt.genSalt(10);
      this.password = await bcrypt.hash(this.password as string, salt);
    } catch (error) {
      return next(error as Error);
    }
  }
  next();
});

// Méthode pour comparer les mots de passe
UserSchema.methods.comparePassword = async function(candidatePassword: string): Promise<boolean> {
  try {
    return await bcrypt.compare(candidatePassword, this.password);
  } catch (error) {
    return false;
  }
};

// Méthode pour générer un token de vérification d'email
UserSchema.methods.generateVerificationToken = function(): string {
  const token = crypto.randomBytes(32).toString('hex');
  this.emailVerificationToken = token;
  this.emailVerificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 heures
  return token;
};

// Méthode pour générer un token de réinitialisation de mot de passe
UserSchema.methods.generatePasswordResetToken = function(): string {
  const token = crypto.randomBytes(32).toString('hex');
  this.passwordResetToken = token;
  this.passwordResetExpires = new Date(Date.now() + 1 * 60 * 60 * 1000); // 1 heure
  return token;
};

export default mongoose.models.User || mongoose.model<IUser>('User', UserSchema);