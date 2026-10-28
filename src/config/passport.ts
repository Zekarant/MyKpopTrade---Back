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
import User from '../models/userModel';
import env from './env';
import { CookieStateStore } from './oauthStateStore';
import { JWT_ALGORITHM } from '../commons/services/tokenService';
import {
  SocialAuthResult,
  linkGoogleAccount,
  signInWithGoogle,
  signInWithFacebook,
  linkDiscordAccount,
  signInWithDiscord
} from '../modules/auth/services/socialAccountService';

/**
 * Les types de passport-oauth2 ne déclarent que les signatures `store(req, cb)`
 * et `store(req, meta, cb)`, alors qu'à l'exécution passport-oauth2 appelle
 * `store(req, state, meta, cb)` pour un magasin d'arité 4 : d'où l'assertion.
 */
function createStateStore(): StateStore {
  return new CookieStateStore() as StateStore;
}

/**
 * Traduit le résultat du service en appel `done` : l'info (`message`, `isLink`,
 * `isNew`) est lue par les contrôleurs de callback (socialAuthController).
 */
function settle(done: VerifyCallback, result: SocialAuthResult): void {
  switch (result.status) {
    case 'authenticated':
      done(null, result.user, { isNew: result.isNew });
      return;
    case 'linked':
      done(null, result.user, { isLink: true });
      return;
    case 'refused':
      done(null, false, { message: result.reason });
  }
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
        async (req: Request, _accessToken: string, _refreshToken: string, profile: GoogleProfile, done: VerifyCallback) => {
          try {
            const email = profile.emails?.[0]?.value;
            if (!email) {
              return done(null, false, { message: 'google_no_email' });
            }

            const identity = {
              id: profile.id,
              email,
              displayName: profile.displayName,
              givenName: profile.name?.givenName,
              familyName: profile.name?.familyName,
              picture: profile.photos?.[0]?.value,
              emailVerified: profile._json?.email_verified
            };
            // req.linkUserId : utilisateur connecté qui lie son compte (cf. googleCallback).
            settle(done, req.linkUserId
              ? await linkGoogleAccount(req.linkUserId, identity)
              : await signInWithGoogle(identity));
          } catch (error) {
            done(error as Error, false);
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
        async (_accessToken: string, _refreshToken: string, profile: FacebookProfile, done: VerifyCallback) => {
          try {
            const email = profile.emails?.[0]?.value;
            if (!email) {
              return done(new Error('Email non fourni par Facebook'), false);
            }

            settle(done, await signInWithFacebook({
              id: profile.id,
              email,
              displayName: profile.displayName,
              givenName: profile.name?.givenName,
              familyName: profile.name?.familyName,
              picture: profile.photos?.[0]?.value
            }));
          } catch (error) {
            done(error as Error, false);
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
        async (req: Request, _accessToken: string, _refreshToken: string, profile: DiscordProfile, done: VerifyCallback) => {
          try {
            if (!profile.email) {
              return done(new Error('Email non fourni par Discord'), false);
            }

            const identity = {
              id: profile.id,
              email: profile.email,
              username: profile.username,
              globalName: profile.global_name,
              avatar: profile.avatar,
              verified: profile.verified
            };
            settle(done, req.linkUserId
              ? await linkDiscordAccount(req.linkUserId, identity)
              : await signInWithDiscord(identity));
          } catch (error) {
            done(error as Error, false);
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
