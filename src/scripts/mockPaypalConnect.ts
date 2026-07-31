import mongoose from 'mongoose';
import dotenv from 'dotenv';
import User from '../models/userModel';

dotenv.config({ path: '.env.local' });

/**
 * Script de test : relie un vendeur à un compte business sandbox sans passer
 * par le parcours d'onboarding PayPal.
 *
 * Le merchant ID se lit dans le Developer Dashboard PayPal, sur la fiche du
 * compte sandbox business (« Account ID »).
 *
 * Le statut d'onboarding est marqué comme périmé (checkedAt à l'époque Unix) :
 * le premier paiement déclenchera un vrai « show seller status », donc ce
 * raccourci ne peut pas faire passer pour encaissable un compte qui ne l'est pas.
 *
 * Usage: npx ts-node src/scripts/mockPaypalConnect.ts <email_vendeur> <merchant_id>
 */
async function mockPaypalConnect(email: string, merchantId: string) {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/mykpoptrade');
    console.log('Connecté à MongoDB');

    const user = await User.findOne({ email });
    if (!user) {
      console.error(`Aucun utilisateur trouvé avec l'email: ${email}`);
      process.exit(1);
    }

    user.paypalMerchantId = merchantId;
    user.paypalConnected = true;
    user.paypalOnboarding = {
      paymentsReceivable: true,
      primaryEmailConfirmed: true,
      consentGranted: true,
      scopes: [],
      checkedAt: new Date(0)
    };
    await user.save();

    console.log(`✅ Compte PayPal sandbox relié (mock) pour ${email}`);
    console.log({
      id: user._id,
      username: user.username,
      paypalMerchantId: user.paypalMerchantId
    });
  } catch (error) {
    console.error('Erreur:', error);
  } finally {
    await mongoose.disconnect();
  }
}

if (process.argv.length < 4) {
  console.log('Usage: npx ts-node src/scripts/mockPaypalConnect.ts <email_vendeur> <merchant_id>');
  process.exit(1);
}

mockPaypalConnect(process.argv[2], process.argv[3]);
