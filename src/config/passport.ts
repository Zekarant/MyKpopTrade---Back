import passport from 'passport';
import { Strategy as JwtStrategy, ExtractJwt } from 'passport-jwt';
import { Request } from 'express';
import {
  Strategy as GoogleStrategy,
  Profile as GoogleProfile,
  VerifyCallback
} from 'passport-google-oauth20';
import {
  Strategy as FacebookStrategy,
  Profile as FacebookProfile
} from 'passport-facebook';
import { Strategy as DiscordStrategy, Profile as DiscordProfile } from 'passport-discord';
import type { StateStore } from 'passport-oauth2';
import User, { IUser } from '../models/userModel';
import crypto from 'crypto';
import env from './env';
import { CookieStateStore } from './oauthStateStore';
import { invalidateAllUserRefreshTokens, JWT_ALGORITHM } from '../commons/services/tokenService';
import {
  generateUniqueUsername,
  splitDisplayName
} from '../modules/auth/services/usernameService';

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
function fillMissingIdentity(
  user: IUser,
  identity: { firstName?: string; lastName?: string; picture?: string }
): void {
  if (!user.firstName && identity.firstName) user.firstName = identity.firstName;
  if (!user.lastName && identity.lastName) user.lastName = identity.lastName;

  const hasCustomPicture =
    user.profilePicture && user.profilePicture !== DEFAULT_PROFILE_PICTURE;
  if (!hasCustomPicture && identity.picture) {
    user.profilePicture = identity.picture;
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

/**
 * Les types de passport-oauth2 ne déclarent que les signatures `store(req, cb)`
 * et `store(req, meta, cb)`, alors qu'à l'exécution passport-oauth2 appelle
 * `store(req, state, meta, cb)` pour un magasin d'arité 4 : d'où l'assertion.
 */
function createStateStore(): StateStore {
  return new CookieStateStore() as StateStore;
}

export const initializePassport = (): void => {
  // Configuration JWT
  passport.use(
    new JwtStrategy(
      {
        jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
        secretOrKey: env.JWT_SECRET,
        algorithms: [JWT_ALGORITHM]
      },
      async (payload, done) => {
        try {
          const user = await User.findById(payload.id);
          if (user && user.accountStatus !== 'deleted') {
            return done(null, user);
          }
          return done(null, false);
        } catch (error) {
          return done(error, false);
        }
      }
    )
  );

  // Configuration Google OAuth
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    passport.use(
      new GoogleStrategy(
        {
          clientID: env.GOOGLE_CLIENT_ID,
          clientSecret: env.GOOGLE_CLIENT_SECRET,
          callbackURL: `${env.API_URL}/api/auth/google/callback`,
          passReqToCallback: true,
          store: createStateStore()
        },
        async (
          req: Request,
          accessToken: string,
          refreshToken: string,
          profile: GoogleProfile,
          done: VerifyCallback
        ) => {
          try {
            const linkUserId = req.linkUserId;
            const email = profile.emails?.[0]?.value;

            if (!email) {
              return done(null, false, { message: 'google_no_email' });
            }

            // MODE LIAISON : l'utilisateur connecté lie son compte Google
            if (linkUserId) {
              const user = await User.findById(linkUserId);
              if (!user) {
                return done(null, false, { message: 'user_not_found' });
              }

              // Vérifier que ce compte Google n'est pas déjà lié à un AUTRE utilisateur
              const existingLink = await User.findOne({ 'socialAuth.google.id': profile.id });
              if (existingLink && existingLink._id.toString() !== linkUserId) {
                return done(null, false, { message: 'account_already_linked' });
              }

              user.socialAuth = user.socialAuth || {};
              user.socialAuth.google = {
                id: profile.id,
                email,
                name: profile.displayName
              };
              fillMissingIdentity(user, {
                firstName: profile.name?.givenName,
                lastName: profile.name?.familyName,
                picture: profile.photos?.[0]?.value
              });
              await user.save({ validateBeforeSave: false });
              return done(null, user, { isLink: true });
            }

            // MODE LOGIN/REGISTER : flow normal
            // D'abord vérifier si ce Google ID est déjà lié à un compte
            let user = await User.findOne({ 'socialAuth.google.id': profile.id });
            let isNew = false;

            if (user) {
              // Ce Google est déjà lié → connexion au compte propriétaire
            } else {
              // Sans email vérifié, rattacher par email offrirait le compte
              // existant à quiconque déclare cette adresse chez le fournisseur.
              if (profile._json?.email_verified === false) {
                return done(null, false, { message: 'google_email_unverified' });
              }
              user = await User.findOne({ email });

              if (user) {
                if (!user.socialAuth?.google?.id) {
                  user.socialAuth = user.socialAuth || {};
                  user.socialAuth.google = {
                    id: profile.id,
                    email,
                    name: profile.displayName
                  };
                  await claimAccountByVerifiedEmail(user);
                  fillMissingIdentity(user, {
                    firstName: profile.name?.givenName,
                    lastName: profile.name?.familyName,
                    picture: profile.photos?.[0]?.value
                  });
                } else if (user.socialAuth.google.id !== profile.id) {
                  return done(null, false, { message: 'email_linked_other_google' });
                }
              } else {
                isNew = true;
                const { firstName, lastName } = splitDisplayName(profile.displayName);

                user = new User({
                  username: await generateUniqueUsername({
                    displayName: profile.displayName,
                    givenName: profile.name?.givenName,
                    familyName: profile.name?.familyName,
                    email
                  }),
                  firstName: profile.name?.givenName || firstName,
                  lastName: profile.name?.familyName || lastName,
                  profilePicture: profile.photos?.[0]?.value || undefined,
                  email,
                  password: generateUnusablePassword(),
                  isEmailVerified: true,
                  // Le front redirige vers /profile-completion tant que `false`.
                  profileCompleted: false,
                  socialAuth: {
                    google: {
                      id: profile.id,
                      email,
                      name: profile.displayName
                    }
                  }
                });
              }
            }

            user.lastLogin = new Date();
            await user.save({ validateBeforeSave: false });
            return done(null, user, { isNew });
          } catch (error) {
            return done(error, false);
          }
        }
      )
    );
  }

  // Configuration Facebook
  if (env.FACEBOOK_APP_ID && env.FACEBOOK_APP_SECRET) {
    passport.use(
      new FacebookStrategy(
        {
          clientID: env.FACEBOOK_APP_ID,
          clientSecret: env.FACEBOOK_APP_SECRET,
          callbackURL: `${env.API_URL}/api/auth/facebook/callback`,
          profileFields: ['id', 'emails', 'name', 'displayName'],
          store: createStateStore()
        },
        async (
          accessToken: string,
          refreshToken: string,
          profile: FacebookProfile,
          done: VerifyCallback
        ) => {
          try {
            const email = profile.emails?.[0]?.value;
            
            if (!email) {
              return done(new Error('Email non fourni par Facebook'), false);
            }

            // Comme pour Google : un Facebook déjà lié désigne son compte, quel
            // que soit l'email qu'il déclare aujourd'hui.
            let user = await User.findOne({ 'socialAuth.facebook.id': profile.id });

            if (!user) {
              user = await User.findOne({ email });
            }

            if (user?.socialAuth?.facebook?.id && user.socialAuth.facebook.id !== profile.id) {
              return done(null, false, { message: 'email_linked_other_facebook' });
            }

            if (user) {
              if (!user.socialAuth?.facebook?.id) {
                user.socialAuth = user.socialAuth || {};
                user.socialAuth.facebook = {
                  id: profile.id,
                  email,
                  name: profile.displayName
                };
                await claimAccountByVerifiedEmail(user);
                fillMissingIdentity(user, {
                  firstName: profile.name?.givenName,
                  lastName: profile.name?.familyName,
                  picture: profile.photos?.[0]?.value
                });
              }
            } else {
              const { firstName, lastName } = splitDisplayName(profile.displayName);

              user = new User({
                username: await generateUniqueUsername({
                  displayName: profile.displayName,
                  givenName: profile.name?.givenName,
                  familyName: profile.name?.familyName,
                  email
                }),
                firstName: profile.name?.givenName || firstName,
                lastName: profile.name?.familyName || lastName,
                profilePicture: profile.photos?.[0]?.value || undefined,
                email,
                password: generateUnusablePassword(),
                isEmailVerified: true,
                profileCompleted: false,
                socialAuth: {
                  facebook: {
                    id: profile.id,
                    email,
                    name: profile.displayName
                  }
                }
              });
              await user.save({ validateBeforeSave: false });
            }

            user.lastLogin = new Date();
            await user.save({ validateBeforeSave: false });
            return done(null, user);
          } catch (error) {
            return done(error, false);
          }
        }
      )
    );
  }

  // Configuration Discord
  if (env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET) {
    passport.use(
      new DiscordStrategy(
        {
          clientID: env.DISCORD_CLIENT_ID,
          clientSecret: env.DISCORD_CLIENT_SECRET,
          callbackURL: `${env.API_URL}/api/auth/discord/callback`,
          scope: ['identify', 'email'],
          passReqToCallback: true,
          store: createStateStore()
        },
        async (
          req: Request,
          accessToken: string,
          refreshToken: string,
          profile: DiscordProfile,
          done: VerifyCallback
        ) => {
          try {
            const linkUserId = req.linkUserId;
            const email = profile.email;
            
            if (!email) {
              return done(new Error('Email non fourni par Discord'), false);
            }

            // MODE LIAISON : l'utilisateur connecté lie son compte Discord
            if (linkUserId) {
              const user = await User.findById(linkUserId);
              if (!user) {
                return done(new Error('Utilisateur non trouvé'), false);
              }

              // Vérifier que ce compte Discord n'est pas déjà lié à un AUTRE utilisateur
              const existingLink = await User.findOne({ 'socialAuth.discord.id': profile.id });
              if (existingLink && existingLink._id.toString() !== linkUserId) {
                return done(new Error('Ce compte Discord est déjà lié à un autre utilisateur'), false);
              }

              user.socialAuth = user.socialAuth || {};
              user.socialAuth.discord = {
                id: profile.id,
                email,
                username: profile.username
              };
              // Auto-fill socialLinks.discord with the Discord username
              user.socialLinks = user.socialLinks || {};
              if (!user.socialLinks.discord) {
                user.socialLinks.discord = profile.username;
              }
              await user.save({ validateBeforeSave: false });
              return done(null, user, { isLink: true });
            }

            // MODE LOGIN/REGISTER : flow normal
            // D'abord vérifier si ce Discord ID est déjà lié à un compte
            let user = await User.findOne({ 'socialAuth.discord.id': profile.id });

            if (user) {
              // Ce Discord est déjà lié → connexion au compte propriétaire
            } else {
              // Discord renvoie aussi des emails non vérifiés : rattacher par
              // email offrirait le compte existant à quiconque déclare l'adresse.
              if (profile.verified !== true) {
                return done(null, false, { message: 'discord_email_unverified' });
              }
              // Pas de liaison existante → chercher par email
              user = await User.findOne({ email });

              if (user) {
                if (!user.socialAuth?.discord?.id) {
                  user.socialAuth = user.socialAuth || {};
                  user.socialAuth.discord = {
                    id: profile.id,
                    email,
                    username: profile.username
                  };
                  await claimAccountByVerifiedEmail(user);
                  // Auto-fill socialLinks.discord
                  user.socialLinks = user.socialLinks || {};
                  if (!user.socialLinks.discord) {
                    user.socialLinks.discord = profile.username;
                  }
                  await user.save({ validateBeforeSave: false });
                } else if (user.socialAuth.discord.id !== profile.id) {
                  // Cet email est lié à un AUTRE Discord → refuser la connexion
                  return done(null, false, { message: 'email_linked_other_discord' });
                }
              } else {
                user = new User({
                  username: await generateUniqueUsername({
                    displayName: profile.global_name || profile.username,
                    email
                  }),
                  profilePicture: profile.avatar
                    ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png`
                    : undefined,
                  email,
                  password: generateUnusablePassword(),
                  isEmailVerified: true,
                  profileCompleted: false,
                  socialAuth: {
                    discord: {
                      id: profile.id,
                      email,
                      username: profile.username
                    }
                  },
                  socialLinks: {
                    discord: profile.username
                  }
                });
                await user.save({ validateBeforeSave: false });
              }
            }

            user.lastLogin = new Date();
            await user.save({ validateBeforeSave: false });
            return done(null, user);
          } catch (error) {
            return done(error, false);
          }
        }
      )
    );
  }

  passport.serializeUser((user: Express.User, done) => {
    done(null, user.id);
  });

  passport.deserializeUser(async (id, done) => {
    try {
      const user = await User.findById(id);
      done(null, user);
    } catch (error) {
      done(error, null);
    }
  });
};