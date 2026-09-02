import jwt, { SignOptions } from 'jsonwebtoken';
import crypto from 'crypto';
import RefreshToken from '../../models/tokenModel';
import env from '../../config/env';

// Liste des tokens d'accès révoqués (utiliser Redis en production)
export const tokenBlacklist = new Set<string>();

/**
 * Génère un token d'accès JWT (courte durée)
 */
export const generateAccessToken = (user: any): string => {
  const payload = { 
    id: user._id, 
    email: user.email,
    username: user.username,
    role: user.role
  };
  
  const options: SignOptions = { expiresIn: env.JWT_EXPIRE as jwt.SignOptions['expiresIn'] };

  return jwt.sign(payload, env.JWT_SECRET, options);
};

/**
 * Génère et enregistre un refresh token (longue durée)
 */
export const generateRefreshToken = async (userId: string): Promise<string> => {
  const token = crypto.randomBytes(40).toString('hex');
  
  await RefreshToken.create({
    token,
    userId,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 jours
  });
  
  return token;
};

/**
 * Vérifie un refresh token et retourne l'ID utilisateur associé
 */
export const verifyRefreshToken = async (token: string): Promise<string | null> => {
  const storedToken = await RefreshToken.findOne({ 
    token, 
    expiresAt: { $gt: new Date() } 
  });
  
  if (!storedToken) return null;
  return storedToken.userId.toString();
};

/**
 * Invalide un refresh token
 */
export const invalidateRefreshToken = async (token: string): Promise<boolean> => {
  const result = await RefreshToken.deleteOne({ token });
  return result.deletedCount > 0;
};

/**
 * Invalide tous les refresh tokens d'un utilisateur
 */
export const invalidateAllUserRefreshTokens = async (userId: string): Promise<boolean> => {
  const result = await RefreshToken.deleteMany({ userId });
  return result.deletedCount > 0;
};