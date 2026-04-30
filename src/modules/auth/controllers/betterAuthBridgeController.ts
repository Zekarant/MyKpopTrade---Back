import { Request, Response } from 'express';
import { getAuth } from '../../../config/betterAuth';
import User from '../../../models/userModel';
import { generateAccessToken, generateRefreshToken } from '../../../commons/services/tokenService';
import logger from '../../../commons/utils/logger';
import env from '../../../config/env';

/**
 * Pont entre better-auth et le système JWT existant.
 *
 * Flow :
 *   1. better-auth termine l'OAuth Google et redirige ici avec sa session-cookie posée.
 *   2. On lit la session better-auth pour récupérer l'email.
 *   3. On synchronise / crée l'utilisateur dans le modèle User existant.
 *   4. On émet la paire JWT historique (accessToken / refreshToken).
 *   5. On redirige vers FRONTEND_URL/auth/callback?... comme l'ancien flow passport.
 */
export const betterAuthBridge = async (req: Request, res: Response): Promise<void> => {
  try {
    const headers = new Headers();
    Object.entries(req.headers).forEach(([key, value]) => {
      if (Array.isArray(value)) {
        value.forEach((v) => headers.append(key, v));
      } else if (value !== undefined) {
        headers.append(key, value as string);
      }
    });

    const auth = await getAuth();
    const session = await auth.api.getSession({ headers });

    if (!session?.user?.email) {
      res.redirect(`${env.FRONTEND_URL}/login?error=better_auth_no_session`);
      return;
    }

    const email = session.user.email;
    const googleId = (session.user as { id?: string }).id;
    const displayName = session.user.name;

    let user = await User.findOne({ email });

    if (user) {
      if (!user.socialAuth?.google?.id && googleId) {
        user.socialAuth = user.socialAuth || {};
        user.socialAuth.google = { id: googleId, email };
        user.isEmailVerified = true;
      }
    } else {
      user = new User({
        username: `user_${Date.now()}`,
        email,
        password: Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2),
        isEmailVerified: true,
        socialAuth: {
          google: { id: googleId ?? '', email },
        },
      });
    }

    user.lastLogin = new Date();
    await user.save();

    const accessToken = generateAccessToken(user);
    const refreshToken = await generateRefreshToken((user._id as { toString(): string }).toString());

    logger.info('Connexion better-auth Google réussie', {
      userId: user._id?.toString().substring(0, 5) + '...',
      username: user.username,
    });

    res.redirect(
      `${env.FRONTEND_URL}/auth/callback?` +
        `accessToken=${accessToken}&` +
        `refreshToken=${refreshToken}&` +
        `userId=${user._id}&` +
        `username=${encodeURIComponent(user.username)}` +
        (displayName ? `&displayName=${encodeURIComponent(displayName)}` : ''),
    );
  } catch (error) {
    logger.error('Erreur bridge better-auth', { error: error instanceof Error ? error.message : String(error) });
    res.redirect(`${env.FRONTEND_URL}/login?error=better_auth_bridge`);
  }
};
