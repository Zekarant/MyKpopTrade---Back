import User from '../../../models/userModel';
import { HttpError } from '../../../commons/utils/httpError';
import logger from '../../../commons/utils/logger';
import env from '../../../config/env';
import { getStripe } from './stripeClient';

/**
 * Onboarding Stripe Connect côté vendeur (Accounts v2 + Account Links).
 *
 * Stripe porte la liability réglementaire (controller_properties par défaut),
 * la plateforme n'a donc pas besoin d'agrément ACPR pour redistribuer les
 * fonds aux vendeurs.
 */


export interface SellerStripeStatus {
  onboarded: boolean;
  payoutsEnabled: boolean;
  chargesEnabled: boolean;
  /** Conditions Stripe encore à fournir (pièces, IBAN, etc.) */
  requirements?: unknown;
  accountId?: string;
}

/**
 * Crée le compte Stripe Connect du vendeur sans redirection vers l'interface Stripe.
 * Le compte existe immédiatement mais payouts_enabled reste false tant que le KYC
 * n'est pas complété (via createOnboardingLink).
 *
 * IMPORTANT — marketplace C2C en Destination Charges :
 * Le vendeur n'encaisse PAS directement de carte bancaire — c'est la plateforme
 * qui charge l'acheteur via `transfer_data.destination`, puis Stripe transfère
 * les fonds au vendeur. On demande donc UNIQUEMENT la capability `transfers`
 * (= destinataire de fonds), surtout pas `card_payments` qui transformerait le
 * vendeur en commerçant Stripe direct et déclencherait le KYB business complet
 * (site web, MCC, description du business, CGV...).
 *
 * Conséquence : `account.charges_enabled` restera toujours à false sur le compte
 * connecté. Pour autoriser une vente côté checkout, vérifier `payouts_enabled`
 * (le vendeur peut-il recevoir un virement ?), pas `charges_enabled`.
 *
 * Idempotent : ne fait rien si le compte existe déjà.
 */
export async function createSellerAccount(userId: string): Promise<{ accountId: string; alreadyExisted: boolean }> {
  const user = await User.findById(userId);
  if (!user) {
    throw new HttpError(404, 'Utilisateur non trouvé');
  }

  if (user.stripeAccountId) {
    return { accountId: user.stripeAccountId, alreadyExisted: true };
  }

  const stripe = getStripe();
  const account = await stripe.accounts.create({
    type: 'express',
    country: 'FR',
    email: user.email,
    // individual = particulier : Stripe demande nom, date de naissance, adresse,
    // IBAN et pièce d'identité. Le business_profile est pré-rempli ici pour que
    // Stripe ne le présente pas dans le formulaire d'onboarding.
    business_type: 'individual',
    capabilities: {
      transfers: { requested: true }
    },
    business_profile: {
      mcc: '5945',
      url: env.MARKETPLACE_URL,
      product_description: 'Vente de cartes de collection K-pop entre particuliers via la marketplace MyKpopTrade',
      support_email: env.SUPPORT_EMAIL
    }
  });

  user.stripeAccountId = account.id;
  await user.save();
  logger.info('Compte Stripe Connect créé', { userId, accountId: account.id });

  return { accountId: account.id, alreadyExisted: false };
}

/**
 * Crée une Account Session pour l'onboarding embarqué (embedded onboarding).
 * Crée le compte si inexistant, puis génère un client_secret (valide 24h)
 * que le frontend utilise avec @stripe/connect-js pour monter le composant
 * <ConnectAccountOnboarding /> sans redirection vers Stripe.
 */
export async function createAccountSession(userId: string): Promise<{ clientSecret: string; accountId: string }> {
  const { accountId } = await createSellerAccount(userId);

  const stripe = getStripe();
  const session = await stripe.accountSessions.create({
    account: accountId,
    components: {
      account_onboarding: { enabled: true }
    }
  });

  return { clientSecret: session.client_secret, accountId };
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
