import jwt, { SignOptions } from 'jsonwebtoken';
import crypto from 'crypto';
import RefreshToken, { IRefreshToken } from '../../models/tokenModel';
import RevokedAccessToken from '../../models/revokedAccessTokenModel';
import { IUser } from '../../models/userModel';
import env from '../../config/env';
import logger from '../utils/logger';

/** Durée de vie d'une session : un jeton renouvelé garde l'échéance d'origine. */
export const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Délai de grâce après un échange : deux onglets peuvent renouveler en même
 * temps avec le même jeton sans être pris pour un vol.
 */
const ROTATION_GRACE_MS = 30 * 1000;

/**
 * Seul algorithme accepté à la vérification d'un JWT : sans liste explicite,
 * c'est l'en-tête `alg` du jeton, choisi par celui qui le présente, qui décide.
 */
export const JWT_ALGORITHM = 'HS256';
export const JWT_VERIFY_OPTIONS: jwt.VerifyOptions = { algorithms: [JWT_ALGORITHM] };

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Génère un token d'accès JWT (courte durée)
 */
export const generateAccessToken = (user: Pick<IUser, '_id' | 'email' | 'username' | 'role'>): string => {
  const payload = {
    id: user._id,
    email: user.email,
    username: user.username,
    role: user.role
  };

  const options: SignOptions = { expiresIn: env.JWT_EXPIRE as jwt.SignOptions['expiresIn'] };

  return jwt.sign(payload, env.JWT_SECRET, options);
};

/** Révoque un jeton d'accès jusqu'à son expiration (déconnexion). */
export const revokeAccessToken = async (token: string): Promise<void> => {
  const decoded = jwt.decode(token) as { exp?: number } | null;
  // Sans `exp`, le jeton n'expire jamais : on le garde révoqué une journée,
  // bien au-delà de la durée de vie des jetons émis par l'API.
  const expiresAt = decoded?.exp ? new Date(decoded.exp * 1000) : new Date(Date.now() + 24 * 60 * 60 * 1000);
  await RevokedAccessToken.updateOne(
    { tokenHash: hashToken(token) },
    { $setOnInsert: { expiresAt } },
    { upsert: true }
  );
};

export const isAccessTokenRevoked = async (token: string): Promise<boolean> =>
  (await RevokedAccessToken.exists({ tokenHash: hashToken(token) })) !== null;

/**
 * Crée un refresh token. Seule son empreinte est stockée : une copie de la
 * base ne donne aucune session utilisable.
 */
async function createRefreshToken(userId: string, expiresAt: Date): Promise<string> {
  const token = crypto.randomBytes(40).toString('hex');
  await RefreshToken.create({ token: hashToken(token), hashed: true, userId, expiresAt });
  return token;
}

/**
 * Génère et enregistre un refresh token (longue durée)
 */
export const generateRefreshToken = async (userId: string): Promise<string> =>
  createRefreshToken(userId, new Date(Date.now() + SESSION_LIFETIME_MS));

/**
 * Échange un refresh token contre un nouveau (usage unique). Un jeton déjà
 * échangé, hors délai de grâce, trahit un vol : toutes les sessions sont fermées.
 *
 * @returns le nouveau jeton et son utilisateur, ou null si le jeton est refusé.
 */
export const rotateRefreshToken = async (
  token: string
): Promise<{ userId: string; refreshToken: string } | null> => {
  const now = new Date();
  const tokenHash = hashToken(token);
  const renew = async (previous: IRefreshToken) => {
    const userId = previous.userId.toString();
    return { userId, refreshToken: await createRefreshToken(userId, previous.expiresAt) };
  };

  // Réservation atomique : deux requêtes simultanées ne peuvent pas toutes
  // deux « gagner » le même jeton.
  const current = await RefreshToken.findOneAndUpdate(
    { token: tokenHash, hashed: true, rotatedAt: { $exists: false }, expiresAt: { $gt: now } },
    { $set: { rotatedAt: now } }
  );
  if (current) return renew(current);

  // Session ouverte avant le hachage : le jeton en clair est consommé.
  const legacy = await RefreshToken.findOneAndDelete({
    token,
    hashed: { $ne: true },
    expiresAt: { $gt: now }
  });
  if (legacy) return renew(legacy);

  const rotated = await RefreshToken.findOne({ token: tokenHash, hashed: true, expiresAt: { $gt: now } });
  if (!rotated?.rotatedAt) return null;

  if (now.getTime() - rotated.rotatedAt.getTime() <= ROTATION_GRACE_MS) {
    return renew(rotated);
  }

  await RefreshToken.deleteMany({ userId: rotated.userId });
  logger.warn('Refresh token réutilisé après échange : sessions du compte fermées', {
    userId: rotated.userId.toString().substring(0, 5) + '...'
  });
  return null;
};

/**
 * Invalide un refresh token
 */
export const invalidateRefreshToken = async (token: string): Promise<boolean> => {
  const result = await RefreshToken.deleteOne({
    $or: [
      { token: hashToken(token), hashed: true },
      { token, hashed: { $ne: true } }
    ]
  });
  return result.deletedCount > 0;
};

/**
 * Invalide tous les refresh tokens d'un utilisateur
 */
export const invalidateAllUserRefreshTokens = async (userId: string): Promise<boolean> => {
  const result = await RefreshToken.deleteMany({ userId });
  return result.deletedCount > 0;
};

/**
 * Ferme toutes les sessions d'un utilisateur sauf celle de `keptToken` (la
 * session courante). Sans jeton à garder, toutes les sessions sont fermées.
 */
export const invalidateOtherUserRefreshTokens = async (userId: string, keptToken?: string): Promise<number> => {
  // Empreinte pour un jeton récent, valeur brute pour une session ouverte avant le hachage.
  const keptValues = keptToken ? [hashToken(keptToken), keptToken] : [];
  const result = await RefreshToken.deleteMany({ userId, token: { $nin: keptValues } });
  return result.deletedCount;
};
