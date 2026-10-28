import crypto from 'crypto';
import { HydratedDocument } from 'mongoose';
import User, { IUser } from '../../../models/userModel';
import { invalidateAllUserRefreshTokens } from '../../../commons/services/tokenService';
import { generateUniqueUsername, splitDisplayName } from './usernameService';

/**
 * Comptes créés, retrouvés ou liés à partir d'une identité OAuth (Google,
 * Facebook, Discord). Les stratégies passport (config/passport.ts) traduisent
 * le profil du fournisseur en identité, puis le résultat en appel `done`.
 */

type UserDocument = HydratedDocument<IUser>;

export type SocialAuthResult =
  | { status: 'authenticated'; user: UserDocument; isNew: boolean }
  | { status: 'linked'; user: UserDocument }
  /** `reason` : code d'erreur repris dans l'URL de redirection vers le front. */
  | { status: 'refused'; reason: string };

/** Identité commune aux fournisseurs ; `email` est exigé en amont. */
interface SocialIdentity {
  id: string;
  email: string;
  displayName: string;
  givenName?: string;
  familyName?: string;
  picture?: string;
}

export interface GoogleIdentity extends SocialIdentity {
  /** `email_verified` du profil Google ; absent = inconnu. */
  emailVerified?: boolean;
}

export type FacebookIdentity = SocialIdentity;

export interface DiscordIdentity {
  id: string;
  email: string;
  username: string;
  globalName?: string | null;
  avatar?: string | null;
  /** Discord renvoie aussi des emails non vérifiés. */
  verified?: boolean;
}

const refused = (reason: string): SocialAuthResult => ({ status: 'refused', reason });

/**
 * Génère le mot de passe d'un compte créé via authentification sociale.
 *
 * L'utilisateur ne connaît jamais cette valeur : il se connecte via son
 * fournisseur, ou définit un vrai mot de passe via « mot de passe oublié ».
 * Elle doit donc être imprédictible, et non issue de `Math.random()` — qui
 * n'est pas cryptographiquement sûr (CWE-338). Comme /auth/login n'interdit pas
 * la connexion par mot de passe sur un compte social, une valeur prédictible
 * ouvrait un chemin de prise de contrôle de compte.
 */
function generateUnusablePassword(): string {
  return crypto.randomBytes(32).toString('hex');
}

/** Valeur par défaut de `profilePicture` déclarée dans le schéma utilisateur. */
const DEFAULT_PROFILE_PICTURE = 'https://mykpoptrade.com/images/avatar-default.png';

/** Complète prénom / nom et photo sans écraser une valeur déjà saisie. */
function fillMissingIdentity(user: IUser, identity: SocialIdentity): void {
  if (!user.firstName && identity.givenName) user.firstName = identity.givenName;
  if (!user.lastName && identity.familyName) user.lastName = identity.familyName;

  const hasCustomPicture = user.profilePicture && user.profilePicture !== DEFAULT_PROFILE_PICTURE;
  if (!hasCustomPicture && identity.picture) {
    user.profilePicture = identity.picture;
  }
}

/** Renseigne le pseudo Discord dans les liens sociaux s'il n'y en a pas encore. */
function fillDiscordSocialLink(user: IUser, discordUsername: string): void {
  user.socialLinks = user.socialLinks || {};
  if (!user.socialLinks.discord) {
    user.socialLinks.discord = discordUsername;
  }
}

/**
 * Prépare un compte existant, trouvé par email, à recevoir un fournisseur OAuth.
 *
 * Un compte dont l'email n'a jamais été vérifié a pu être créé par un tiers qui
 * a déclaré l'adresse de la victime sans la posséder. Le fournisseur prouve
 * maintenant que l'adresse appartient à quelqu'un d'autre : le mot de passe, la
 * 2FA et les sessions posés par ce tiers sont révoqués, sinon il garderait
 * l'accès au compte que le vrai propriétaire vient de vérifier.
 */
async function claimAccountByVerifiedEmail(user: IUser): Promise<void> {
  if (!user.isEmailVerified) {
    user.password = generateUnusablePassword();
    user.twoFactor = { enabled: false };
    await invalidateAllUserRefreshTokens(String(user._id));
  }
  user.isEmailVerified = true;
}

/** Nouveau compte (non enregistré) pour une identité Google ou Facebook. */
async function newUserFromIdentity(identity: SocialIdentity, socialAuth: IUser['socialAuth']): Promise<UserDocument> {
  const { firstName, lastName } = splitDisplayName(identity.displayName);
  return new User({
    username: await generateUniqueUsername({
      displayName: identity.displayName,
      givenName: identity.givenName,
      familyName: identity.familyName,
      email: identity.email
    }),
    firstName: identity.givenName || firstName,
    lastName: identity.familyName || lastName,
    profilePicture: identity.picture || undefined,
    email: identity.email,
    password: generateUnusablePassword(),
    isEmailVerified: true,
    // Le front redirige vers /profile-completion tant que `false`.
    profileCompleted: false,
    socialAuth
  });
}

/** Enregistre la connexion et rend le résultat d'authentification. */
async function recordLogin(user: UserDocument, isNew: boolean): Promise<SocialAuthResult> {
  user.lastLogin = new Date();
  await user.save({ validateBeforeSave: false });
  return { status: 'authenticated', user, isNew };
}

/** Lie un compte Google à l'utilisateur connecté `userId`. */
export async function linkGoogleAccount(userId: string, identity: GoogleIdentity): Promise<SocialAuthResult> {
  const user = await User.findById(userId);
  if (!user) return refused('user_not_found');

  const existingLink = await User.findOne({ 'socialAuth.google.id': identity.id }).select('_id').lean();
  if (existingLink && existingLink._id.toString() !== userId) {
    return refused('account_already_linked');
  }

  user.socialAuth = user.socialAuth || {};
  user.socialAuth.google = { id: identity.id, email: identity.email, name: identity.displayName };
  fillMissingIdentity(user, identity);
  await user.save({ validateBeforeSave: false });
  return { status: 'linked', user };
}

/** Connexion ou inscription via Google. */
export async function signInWithGoogle(identity: GoogleIdentity): Promise<SocialAuthResult> {
  // Un Google déjà lié désigne son compte, quel que soit l'email déclaré.
  const linked = await User.findOne({ 'socialAuth.google.id': identity.id });
  if (linked) return recordLogin(linked, false);

  // Sans email vérifié, rattacher par email offrirait le compte existant à
  // quiconque déclare cette adresse chez le fournisseur.
  if (identity.emailVerified === false) return refused('google_email_unverified');

  const googleAuth = { google: { id: identity.id, email: identity.email, name: identity.displayName } };
  const user = await User.findOne({ email: identity.email });
  if (!user) {
    return recordLogin(await newUserFromIdentity(identity, googleAuth), true);
  }

  if (user.socialAuth?.google?.id) {
    // Cet email est déjà lié à un AUTRE compte Google.
    return refused('email_linked_other_google');
  }

  user.socialAuth = user.socialAuth || {};
  user.socialAuth.google = googleAuth.google;
  await claimAccountByVerifiedEmail(user);
  fillMissingIdentity(user, identity);
  return recordLogin(user, false);
}

/** Connexion ou inscription via Facebook. */
export async function signInWithFacebook(identity: FacebookIdentity): Promise<SocialAuthResult> {
  // Comme pour Google : un Facebook déjà lié désigne son compte, quel que soit
  // l'email qu'il déclare aujourd'hui.
  const user = await User.findOne({ 'socialAuth.facebook.id': identity.id })
    ?? await User.findOne({ email: identity.email });

  const facebookAuth = { facebook: { id: identity.id, email: identity.email, name: identity.displayName } };
  if (!user) {
    return recordLogin(await newUserFromIdentity(identity, facebookAuth), true);
  }

  const linkedFacebookId = user.socialAuth?.facebook?.id;
  if (linkedFacebookId && linkedFacebookId !== identity.id) {
    return refused('email_linked_other_facebook');
  }

  if (!linkedFacebookId) {
    user.socialAuth = user.socialAuth || {};
    user.socialAuth.facebook = facebookAuth.facebook;
    await claimAccountByVerifiedEmail(user);
    fillMissingIdentity(user, identity);
  }
  return recordLogin(user, false);
}

/** Lie un compte Discord à l'utilisateur connecté `userId`. */
export async function linkDiscordAccount(userId: string, identity: DiscordIdentity): Promise<SocialAuthResult> {
  const user = await User.findById(userId);
  if (!user) return refused('user_not_found');

  const existingLink = await User.findOne({ 'socialAuth.discord.id': identity.id }).select('_id').lean();
  if (existingLink && existingLink._id.toString() !== userId) {
    return refused('account_already_linked');
  }

  user.socialAuth = user.socialAuth || {};
  user.socialAuth.discord = { id: identity.id, email: identity.email, username: identity.username };
  fillDiscordSocialLink(user, identity.username);
  await user.save({ validateBeforeSave: false });
  return { status: 'linked', user };
}

/** Connexion ou inscription via Discord. */
export async function signInWithDiscord(identity: DiscordIdentity): Promise<SocialAuthResult> {
  const linked = await User.findOne({ 'socialAuth.discord.id': identity.id });
  if (linked) return recordLogin(linked, false);

  // Rattacher par un email non vérifié offrirait le compte existant à
  // quiconque déclare l'adresse.
  if (identity.verified !== true) return refused('discord_email_unverified');

  const discordAuth = { discord: { id: identity.id, email: identity.email, username: identity.username } };
  const user = await User.findOne({ email: identity.email });
  if (!user) {
    const newUser = new User({
      username: await generateUniqueUsername({
        displayName: identity.globalName || identity.username,
        email: identity.email
      }),
      profilePicture: identity.avatar
        ? `https://cdn.discordapp.com/avatars/${identity.id}/${identity.avatar}.png`
        : undefined,
      email: identity.email,
      password: generateUnusablePassword(),
      isEmailVerified: true,
      profileCompleted: false,
      socialAuth: discordAuth,
      socialLinks: { discord: identity.username }
    });
    return recordLogin(newUser, true);
  }

  if (user.socialAuth?.discord?.id) {
    // Cet email est lié à un AUTRE Discord.
    return refused('email_linked_other_discord');
  }

  user.socialAuth = user.socialAuth || {};
  user.socialAuth.discord = discordAuth.discord;
  await claimAccountByVerifiedEmail(user);
  fillDiscordSocialLink(user, identity.username);
  return recordLogin(user, false);
}
