import mongoose from 'mongoose';
import dotenv from 'dotenv';
import User from '../models/userModel';

dotenv.config({ path: '.env.local' });

/**
 * Script de test : simule la connexion PayPal d'un vendeur
 * Usage: npx ts-node src/scripts/mockPaypalConnect.ts <email>
 */
async function mockPaypalConnect(email: string) {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/mykpoptrade');
    console.log('Connecté à MongoDB');

    const user = await User.findOne({ email });
    if (!user) {
      console.error(`Aucun utilisateur trouvé avec l'email: ${email}`);
      process.exit(1);
    }

    user.paypalEmail = email;
    user.paypalConnected = true;
    user.paypalTokens = {
      accessToken: 'MOCK_ACCESS_TOKEN_FOR_TESTING',
      refreshToken: 'MOCK_REFRESH_TOKEN_FOR_TESTING',
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) // +1 an
    };
    await user.save();

    console.log(`✅ PayPal connecté (mock) pour ${email}`);
    console.log({
      id: user._id,
      username: user.username,
      paypalEmail: user.paypalEmail,
      paypalConnected: user.paypalConnected
    });
  } catch (error) {
    console.error('Erreur:', error);
  } finally {
    await mongoose.disconnect();
  }
}

if (process.argv.length < 3) {
  console.log('Usage: npx ts-node src/scripts/mockPaypalConnect.ts <email_vendeur>');
  process.exit(1);
}

mockPaypalConnect(process.argv[2]);
