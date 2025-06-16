import { Schema, model } from 'mongoose';
import bcrypt from 'bcrypt';

interface IUserEmail {
    email: string;
    password?: string;
    createdAt?: Date;
}

const UserSchema = new Schema < IUserEmail > ({
    email: {
        type: String,
        required: true,
        unique: true
    },
    password: {
        type: String,
        required: true,
        select: false
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

UserSchema.methods.comparePassword = async function(candidatePassword: string): Promise<boolean> {
  try {
    if (!candidatePassword) {
      throw new Error('Le mot de passe candidat est requis');
    }
    
    if (!this.password) {
      throw new Error('Le mot de passe utilisateur n\'est pas disponible pour la comparaison. Assurez-vous d\'utiliser .select(\'+password\') lors de la requête.');
    }
    
    return await bcrypt.compare(candidatePassword, this.password);
  } catch (error) {
    console.error('Erreur lors de la comparaison du mot de passe:', error);
    throw error; 
  }
};

// On récupère le mot de passe avant de sauvegarder l'utilisateur
UserSchema.statics.findByIdWithPassword = function(userId: string) {
  return this.findById(userId).select('+password');
};

UserSchema.statics.findByEmailWithPassword = function(email: string) {
  return this.findOne({ email }).select('+password');
};

export default model < IUserEmail > ('UserEmail', UserSchema);