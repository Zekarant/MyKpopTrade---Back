import mongoose, { Schema, Document } from 'mongoose';
import bcrypt from 'bcrypt';

export interface IUser extends Document {
  username: string;
  email: string;
  numberPhone?: string;
  password: string;
  socialAuth?: {
    discord?: {
      id: string;
      username: string;
    };
    google?: {
      id: string;
      name: string;
    };
    facebook?: {
      id: string;
      name: string;
    };
  };
  comparePassword(candidatePassword: string): Promise<boolean>;
}

const UserSchema: Schema = new Schema({
  username: {
    type: String,
    required: [true, 'Veuillez entrer un nom d\'utilisateur'],
    trim: true,
    unique: true
  },
  email: {
    type: String,
    required: [true, 'Veuillez entrer une adresse email'],
    unique: true,
    trim: true,
    lowercase: true
  },
  numberPhone: {
    type: String,
    required: false,
    trim: true
  },
  password: {
    type: String,
    required: [true, 'Veuillez entrer un mot de passe'],
    minlength: [8, 'Le mot de passe doit contenir au moins 8 caractères']
  },
  socialAuth: {
    discord: {
      id: String,
      username: String
    },
    google: {
      id: String,
      name: String
    },
    facebook: {
      id: String,
      name: String
    }
  }
}, { timestamps: true });

// Méthode pour comparer les mots de passe
UserSchema.methods.comparePassword = async function(candidatePassword: string): Promise<boolean> {
  return bcrypt.compare(candidatePassword, this.password);
};

export default mongoose.model<IUser>('User', UserSchema);