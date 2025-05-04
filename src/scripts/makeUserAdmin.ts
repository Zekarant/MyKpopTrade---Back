import mongoose from 'mongoose';
import dotenv from 'dotenv';
import User from '../models/userModel';
import logger from '../commons/utils/logger';

// Charger les variables d'environnement
dotenv.config({ path: '.env.local' });

// Fonction pour promouvoir un utilisateur en admin
async function makeUserAdmin(email: string) {
  try {
    // Connexion à la base de données
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/mykpoptrade');
    console.log('Connecté à MongoDB');

    // Rechercher l'utilisateur par email
    const user = await User.findOne({ email });

    if (!user) {
      console.error(`Aucun utilisateur trouvé avec l'email: ${email}`);
      process.exit(1);
    }

    // Mettre à jour le rôle de l'utilisateur
    user.role = 'admin';
    await user.save();

    console.log(`L'utilisateur ${email} a été promu administrateur avec succès !`);
    
    // Afficher les informations de l'utilisateur
    console.log({
      id: user._id,
      username: user.username,
      email: user.email,
      role: user.role
    });

  } catch (error) {
    console.error('Erreur:', error);
  } finally {
    await mongoose.disconnect();
    console.log('Déconnecté de MongoDB');
  }
}

// Vérifier les arguments
if (process.argv.length < 3) {
  console.log('Usage: npx ts-node src/scripts/makeUserAdmin.ts <email>');
  process.exit(1);
}

const email = process.argv[2];
makeUserAdmin(email);