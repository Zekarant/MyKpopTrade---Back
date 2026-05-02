import passport from 'passport';
import { Strategy as JwtStrategy, ExtractJwt } from 'passport-jwt';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { Strategy as FacebookStrategy } from 'passport-facebook';
import { Strategy as DiscordStrategy } from 'passport-discord';
import User from '../models/userModel';
import dotenv from 'dotenv';

dotenv.config();

export const initializePassport = (): void => {
  // Configuration JWT
  passport.use(
    new JwtStrategy(
      {
        jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
        secretOrKey: process.env.JWT_SECRET || 'default_jwt_secret'
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
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    passport.use(
      new GoogleStrategy(
        {
          clientID: process.env.GOOGLE_CLIENT_ID,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          callbackURL: `${process.env.API_URL}/api/auth/google/callback`
        },
        async (accessToken, refreshToken, profile, done) => {
          try {
            const email = profile.emails?.[0]?.value;

            if (!email) {
              return done(null, false, { message: 'google_no_email' });
            }

            let user = await User.findOne({ email });
            const isNew = !user;

            if (user) {
              // Lier le compte Google à un utilisateur existant si pas encore fait.
              if (!user.socialAuth?.google?.id) {
                user.socialAuth = user.socialAuth || {};
                user.socialAuth.google = {
                  id: profile.id,
                  email,
                  name: profile.displayName
                };
                user.isEmailVerified = true;
              }
            } else {
              user = new User({
                username: `user_${Date.now()}`,
                email,
                password: Math.random().toString(36).substring(2),
                isEmailVerified: true,
                socialAuth: {
                  google: {
                    id: profile.id,
                    email,
                    name: profile.displayName
                  }
                }
              });
            }

            user.lastLogin = new Date();
            await user.save();
            return done(null, user, { isNew });
          } catch (error) {
            return done(error, false);
          }
        }
      )
    );
  }

  // Configuration Facebook
  if (process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET) {
    passport.use(
      new FacebookStrategy(
        {
          clientID: process.env.FACEBOOK_APP_ID,
          clientSecret: process.env.FACEBOOK_APP_SECRET,
          callbackURL: `${process.env.API_URL}/api/auth/facebook/callback`,
          profileFields: ['id', 'emails', 'name', 'displayName']
        },
        async (accessToken, refreshToken, profile, done) => {
          try {
            const email = profile.emails?.[0]?.value;
            
            if (!email) {
              return done(new Error('Email non fourni par Facebook'), false);
            }

            // Même logique que pour Google
            let user = await User.findOne({ email });

            if (user) {
              if (!user.socialAuth?.facebook?.id) {
                user.socialAuth = user.socialAuth || {};
                user.socialAuth.facebook = {
                  id: profile.id,
                  email,
                  name: profile.displayName
                };
                user.isEmailVerified = true;
                await user.save();
              }
            } else {
              user = new User({
                username: `user_${Date.now()}`,
                email,
                password: Math.random().toString(36).substring(2),
                isEmailVerified: true,
                socialAuth: {
                  facebook: {
                    id: profile.id,
                    email,
                    name: profile.displayName
                  }
                }
              });
              await user.save();
            }

            user.lastLogin = new Date();
            await user.save();
            return done(null, user);
          } catch (error) {
            return done(error, false);
          }
        }
      )
    );
  }

  // Configuration Discord
  if (process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET) {
    passport.use(
      new DiscordStrategy(
        {
          clientID: process.env.DISCORD_CLIENT_ID,
          clientSecret: process.env.DISCORD_CLIENT_SECRET,
          callbackURL: `${process.env.API_URL}/api/auth/discord/callback`,
          scope: ['identify', 'email']
        },
        async (accessToken, refreshToken, profile, done) => {
          try {
            const email = profile.email;
            
            if (!email) {
              return done(new Error('Email non fourni par Discord'), false);
            }

            // Même logique que pour les autres providers
            let user = await User.findOne({ email });

            if (user) {
              if (!user.socialAuth?.discord?.id) {
                user.socialAuth = user.socialAuth || {};
                user.socialAuth.discord = {
                  id: profile.id,
                  email,
                  username: profile.username
                };
                user.isEmailVerified = true;
                await user.save();
              }
            } else {
              user = new User({
                username: `user_${Date.now()}`,
                email,
                password: Math.random().toString(36).substring(2),
                isEmailVerified: true,
                socialAuth: {
                  discord: {
                    id: profile.id,
                    email,
                    username: profile.username
                  }
                }
              });
              await user.save();
            }

            user.lastLogin = new Date();
            await user.save();
            return done(null, user);
          } catch (error) {
            return done(error, false);
          }
        }
      )
    );
  }

  passport.serializeUser((user: any, done) => {
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