import passport from 'passport';
import { Strategy as JwtStrategy, ExtractJwt } from 'passport-jwt';
import { Strategy as DiscordStrategy } from 'passport-discord';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { Strategy as FacebookStrategy } from 'passport-facebook';
import User from '../models/userModel';
import dotenv from 'dotenv';

dotenv.config();

// Options pour la stratégie JWT
const jwtOptions = {
  jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
  secretOrKey: process.env.JWT_SECRET || 'userLogin'
};

// Initialisation de Passport
export const initializePassport = () => {
  // Stratégie JWT (pour les tokens)
  passport.use(
    new JwtStrategy(jwtOptions, async (jwtPayload, done) => {
      try {
        const user = await User.findById(jwtPayload.id);
        if (user) {
          return done(null, user);
        }
        return done(null, false);
      } catch (error) {
        return done(error, false);
      }
    })
  );

  // Stratégie Discord
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
            // Chercher si l'utilisateur existe déjà
            let user = await User.findOne({ 
              $or: [
                { 'socialAuth.discord.id': profile.id },
                { email: profile.email }
              ]
            });

            if (!user) {
              // Créer un nouvel utilisateur
              user = new User({
                username: profile.username || `discord_${profile.id}`,
                email: profile.email,
                socialAuth: {
                  discord: {
                    id: profile.id,
                    username: profile.username
                  }
                },
                password: Math.random().toString(36).slice(-10) // Mot de passe aléatoire
              });
              await user.save();
            } else if (!user.socialAuth?.discord?.id) {
              // Lier le compte Discord à un utilisateur existant
              user.socialAuth = user.socialAuth || {};
              user.socialAuth.discord = {
                id: profile.id,
                username: profile.username
              };
              await user.save();
            }
            
            return done(null, user);
          } catch (error) {
            return done(error, false);
          }
        }
      )
    );
  }

  // Stratégie Google
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
              return done(new Error("Email non fourni par Google"), false);
            }

            let user = await User.findOne({
              $or: [
                { 'socialAuth.google.id': profile.id },
                { email: email }
              ]
            });

            if (!user) {
              user = new User({
                username: profile.displayName || `google_${profile.id}`,
                email: email,
                socialAuth: {
                  google: {
                    id: profile.id,
                    name: profile.displayName
                  }
                },
                password: Math.random().toString(36).slice(-10)
              });
              await user.save();
            } else if (!user.socialAuth?.google?.id) {
              user.socialAuth = user.socialAuth || {};
              user.socialAuth.google = {
                id: profile.id,
                name: profile.displayName
              };
              await user.save();
            }

            return done(null, user);
          } catch (error) {
            return done(error, false);
          }
        }
      )
    );
  }

  // Stratégie Facebook
  if (process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET) {
    passport.use(
      new FacebookStrategy(
        {
          clientID: process.env.FACEBOOK_APP_ID,
          clientSecret: process.env.FACEBOOK_APP_SECRET,
          callbackURL: `${process.env.API_URL}/api/auth/facebook/callback`,
          profileFields: ['id', 'displayName', 'email']
        },
        async (accessToken, refreshToken, profile, done) => {
          try {
            const email = profile.emails?.[0]?.value;
            
            let user = await User.findOne({
              $or: [
                { 'socialAuth.facebook.id': profile.id },
                { email: email }
              ]
            });

            if (!user) {
              user = new User({
                username: profile.displayName || `fb_${profile.id}`,
                email: email || `fb_${profile.id}@placeholder.com`,
                socialAuth: {
                  facebook: {
                    id: profile.id,
                    name: profile.displayName
                  }
                },
                password: Math.random().toString(36).slice(-10)
              });
              await user.save();
            } else if (!user.socialAuth?.facebook?.id) {
              user.socialAuth = user.socialAuth || {};
              user.socialAuth.facebook = {
                id: profile.id,
                name: profile.displayName
              };
              await user.save();
            }

            return done(null, user);
          } catch (error) {
            return done(error, false);
          }
        }
      )
    );
  }

  // Sérialisation et désérialisation pour les sessions
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