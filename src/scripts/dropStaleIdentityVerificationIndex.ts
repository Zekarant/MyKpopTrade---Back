import mongoose from 'mongoose';
import dotenv from 'dotenv';
import IdentityVerification from '../models/identityVerificationModel';

// Charger les variables d'environnement
dotenv.config({ path: '.env.local' });

// L'ancien index unique (user, expiresAt) a été remplacé par un index unique
// sur (user) seul (cf. src/models/identityVerificationModel.ts). Mongoose ne
// supprime jamais automatiquement un ancien index : ce script le fait une
// bonne fois pour toutes sur chaque environnement déployé avant cette version.
const STALE_INDEX_NAME = 'user_1_expiresAt_1';

async function dropStaleIndex() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/mykpoptrade');
    console.log('Connecté à MongoDB');

    const existingIndexes = await IdentityVerification.collection.indexes();
    const staleIndex = existingIndexes.find((index) => index.name === STALE_INDEX_NAME);

    if (!staleIndex) {
      console.log(`Index "${STALE_INDEX_NAME}" déjà absent, rien à faire.`);
      return;
    }

    await IdentityVerification.collection.dropIndex(STALE_INDEX_NAME);
    console.log(`Index "${STALE_INDEX_NAME}" supprimé avec succès.`);
  } catch (error) {
    console.error('Erreur:', error);
  } finally {
    await mongoose.disconnect();
    console.log('Déconnecté de MongoDB');
  }
}

dropStaleIndex();
