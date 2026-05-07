import User from '../../../models/userModel';
import { HttpError } from '../../../commons/utils/httpError';
import logger from '../../../commons/utils/logger';
import { getStripe } from './stripeClient';

/**
 * Onboarding Stripe Connect côté vendeur (Accounts v2 + Account Links).
 *
 * Stripe porte la liability réglementaire (controller_properties par défaut),
 * la plateforme n'a donc pas besoin d'agrément ACPR pour redistribuer les
 * fonds aux vendeurs.
 */

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:8080';

export interface SellerStripeStatus {
  onboarded: boolean;
  payoutsEnabled: boolean;
  chargesEnabled: boolean;
  /** Conditions Stripe encore à fournir (pièces, IBAN, etc.) */
  requirements?: unknown;
  accountId?: string;
}

/**
 * Génère un lien d'onboarding Stripe pour le vendeur. Crée le compte connecté
 * lors du premier appel, puis ne fait que régénérer le lien (5 min de validité)
 * aux appels suivants.
 *
 * Utilise Accounts v1 type=express : API stable depuis 2018, ne nécessite pas
 * le preview Accounts v2. Le compte Express est hébergé par Stripe (UI fournie),
 * la liability reste portée par Stripe.
 */
export async function createOnboardingLink(userId: string): Promise<{ url: string }> {
  const user = await User.findById(userId);
  if (!user) {
    throw new HttpError(404, 'Utilisateur non trouvé');
  }

  const stripe = getStripe();

  if (!user.stripeAccountId) {
    const account = await stripe.accounts.create({
      type: 'express',
      country: 'FR',
      email: user.email,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true }
      },
      business_type: 'individual'
    });
    user.stripeAccountId = account.id;
    await user.save();
    logger.info('Compte Stripe Connect créé', { userId, accountId: account.id });
  }

  const accountLink = await stripe.accountLinks.create({
    account: user.stripeAccountId,
    refresh_url: `${FRONTEND_URL}/seller/onboarding?refresh=1`,
    return_url: `${FRONTEND_URL}/seller/onboarding-complete`,
    type: 'account_onboarding'
  });

  return { url: accountLink.url };
}

/**
 * Récupère l'état KYC du vendeur côté Stripe.
 */
export async function getSellerStatus(userId: string): Promise<SellerStripeStatus> {
  const user = await User.findById(userId);
  if (!user) {
    throw new HttpError(404, 'Utilisateur non trouvé');
  }

  if (!user.stripeAccountId) {
    return { onboarded: false, payoutsEnabled: false, chargesEnabled: false };
  }

  const stripe = getStripe();
  const account = await stripe.accounts.retrieve(user.stripeAccountId);

  const payoutsEnabled = Boolean(account.payouts_enabled);
  const chargesEnabled = Boolean(account.charges_enabled);

  if (
    user.stripePayoutsEnabled !== payoutsEnabled ||
    user.stripeChargesEnabled !== chargesEnabled
  ) {
    user.stripePayoutsEnabled = payoutsEnabled;
    user.stripeChargesEnabled = chargesEnabled;
    await user.save();
  }

  return {
    onboarded: true,
    payoutsEnabled,
    chargesEnabled,
    requirements: account.requirements,
    accountId: user.stripeAccountId
  };
}
