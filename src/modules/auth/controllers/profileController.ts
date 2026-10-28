import { Request, Response } from 'express';
import {
  getPublicProfileData,
  updateProfileData,
  completeFirstProfile,
  setPayPalEmail,
  clearPayPalEmail
} from '../services/authProfileService';

/**
 * Récupère le profil de l'utilisateur authentifié
 * @route GET /api/auth/profile
 */
export const getProfile = async (req: Request, res: Response): Promise<void> => {
  const user = await getPublicProfileData(req.user!.id);
  res.status(200).json({ user });
};

/**
 * Marque le profil comme complété (OAuth first login).
 * Le front l'appelle après une inscription via Google/Discord.
 * @route POST /api/auth/profile/complete
 */
export const completeProfile = async (req: Request, res: Response): Promise<void> => {
  const result = await completeFirstProfile(req.user!.id, req.body);
  res.status(200).json(result);
};

/**
 * Met à jour le profil complet de l'utilisateur authentifié
 * @route PUT /api/auth/profile
 */
export const updateProfile = async (req: Request, res: Response): Promise<void> => {
  const result = await updateProfileData(req.user!.id, req.body);
  res.status(200).json(result);
};

/**
 * Met à jour uniquement l'email PayPal de l'utilisateur authentifié
 * @route PUT /api/auth/profile/paypal-email
 */
export const updatePayPalEmail = async (req: Request, res: Response): Promise<void> => {
  const { paypalEmail, confirmPassword } = req.body;

  const newPayPalEmail = await setPayPalEmail(req.user!.id, paypalEmail, confirmPassword);

  res.status(200).json({
    message: 'Email PayPal mis à jour avec succès',
    paypalEmail: newPayPalEmail
  });
};

/**
 * Supprime l'email PayPal de l'utilisateur authentifié
 * @route DELETE /api/auth/profile/paypal-email
 */
export const removePayPalEmail = async (req: Request, res: Response): Promise<void> => {
  await clearPayPalEmail(req.user!.id, req.body?.confirmPassword);
  res.status(200).json({ message: 'Email PayPal supprimé avec succès' });
};
