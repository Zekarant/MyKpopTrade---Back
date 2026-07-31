import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

import User from '../models/userModel';
import { PayPalPartnerService, SELLER_BLOCK_MESSAGES } from '../modules/payments/services/paypalPartnerService';
import { paymentConfig } from '../config/paymentConfig';

/**
 * Diagnostic PayPal : affiche l'état d'onboarding de chaque vendeur et
 * interroge PayPal en direct pour dire ce qui bloque.
 *
 * Usage: npx ts-node src/scripts/paypalStatus.ts [email]
 */

const YES = '\x1b[32m✓\x1b[0m';
const NO = '\x1b[31m✗\x1b[0m';
const flag = (value: unknown) => (value ? YES : NO);

async function main(email?: string) {
  console.log('\n=== Configuration ===');
  console.log(`Mode            : ${paymentConfig.paypal.mode}`);
  console.log(`Client ID       : ${paymentConfig.paypal.clientId ? paymentConfig.paypal.clientId.slice(0, 12) + '…' : NO + ' manquant'}`);
  console.log(`BN code         : ${paymentConfig.paypal.bnCode || NO + ' manquant'}`);
  console.log(`Partner merchant: ${paymentConfig.paypal.partnerMerchantId || NO + ' manquant'}`);
  console.log(`Webhook ID      : ${paymentConfig.paypal.webhookId || NO + ' manquant'}`);
  console.log(`Commission      : ${paymentConfig.paypal.platformFeePercent} %`);

  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/mykpoptrade');

  const filter: any = email
    ? { email }
    : { $or: [{ paypalMerchantId: { $ne: null } }, { paypalTrackingId: { $ne: null } }] };

  const sellers = await User.find(filter).select(
    'email username paypalEmail paypalConnected paypalMerchantId paypalTrackingId paypalOnboarding'
  );

  if (sellers.length === 0) {
    console.log('\nAucun vendeur n\'a commencé l\'onboarding PayPal.');
    console.log('→ Connecte-toi sur le site, Paramètres > Connecter mon compte PayPal.\n');
    return;
  }

  console.log(`\n=== ${sellers.length} vendeur(s) ===`);

  for (const seller of sellers) {
    console.log(`\n${seller.username} <${seller.email}>`);
    console.log(`  tracking_id  : ${seller.paypalTrackingId || '—'}`);
    console.log(`  merchant_id  : ${seller.paypalMerchantId || '—'}`);
    console.log(`  email PayPal : ${seller.paypalEmail || '—'}`);

    if (!seller.paypalMerchantId) {
      console.log(`  ${NO} Onboarding démarré mais jamais terminé.`);
      console.log('     → PayPal n\'a pas renvoyé le vendeur, ou le retour a échoué.');
      console.log('     → Relance « Connecter mon compte PayPal ».');
      continue;
    }

    // Interrogation live de PayPal — c'est la source de vérité.
    let status;
    try {
      status = await PayPalPartnerService.fetchSellerStatus(seller.paypalMerchantId);
    } catch (error) {
      console.log(`  ${NO} Appel PayPal en échec : ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    if (!status) {
      console.log(`  ${NO} PayPal ne connaît pas ce merchant ID.`);
      continue;
    }

    console.log(`  ${flag(status.primaryEmailConfirmed)} Email confirmé`);
    console.log(`  ${flag(status.paymentsReceivable)} Peut recevoir des paiements`);
    console.log(`  ${flag(status.consentGranted)} Permissions accordées à MyKpopTrade`);

    if (status.scopes.length) {
      console.log(`     scopes : ${status.scopes.map((s) => s.split('/').pop()).join(', ')}`);
    }

    if (PayPalPartnerService.isReady(status)) {
      console.log('  \x1b[32m→ Prêt à vendre et à être payé.\x1b[0m');
    } else {
      const reason = !status.consentGranted
        ? 'CONSENT_MISSING'
        : !status.primaryEmailConfirmed
          ? 'EMAIL_UNCONFIRMED'
          : 'PAYMENTS_NOT_RECEIVABLE';
      console.log(`  \x1b[33m→ ${SELLER_BLOCK_MESSAGES[reason as keyof typeof SELLER_BLOCK_MESSAGES]}\x1b[0m`);
    }
  }

  console.log('');
}

main(process.argv[2])
  .catch((error) => {
    console.error('\nErreur :', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
