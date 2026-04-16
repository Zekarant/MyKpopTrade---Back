import { Request, Response } from 'express';
import logger from '../../../commons/utils/logger';
import { HttpError } from '../../../commons/utils/httpError';
import {
  getPublicProfileData,
  updateProfileData,
  softDeleteAccount,
  setPayPalEmail,
  clearPayPalEmail
} from '../services/authProfileService';

function handleHttpError(res: Response, error: unknown): boolean {
  if (error instanceof HttpError) {
    res.status(error.statusCode).json({ message: error.message });
    return true;
  }
  return false;
}

/**
 * Récupère le profil de l'utilisateur authentifié
 */
export const getProfile = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = (req.user as any).id;
    const user = await getPublicProfileData(userId);
    res.status(200).json({ user });
  } catch (error) {
    if (handleHttpError(res, error)) return;

    logger.error('Erreur lors de la récupération du profil:', error);
    res.status(500).json({ message: 'Erreur lors de la récupération du profil' });
  }
};

/**
 * Met à jour le profil complet de l'utilisateur authentifié
 */
export const updateProfile = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = (req.user as any).id;
    const result = await updateProfileData(userId, req.body);
    res.status(200).json(result);
  } catch (error) {
    if (handleHttpError(res, error)) return;

    logger.error('Erreur lors de la mise à jour du profil:', error);
    res.status(500).json({ message: 'Erreur lors de la mise à jour du profil' });
  }
};

/**
 * Supprime le compte de l'utilisateur authentifié
 * Le compte est marqué pour suppression et sera définitivement supprimé après 30 jours
 */
export const deleteAccount = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = (req.user as any).id;
    const { password } = req.body;

    await softDeleteAccount(userId, password);

    res.status(200).json({ message: 'Votre compte a été supprimé avec succès' });
  } catch (error) {
    if (handleHttpError(res, error)) return;

    logger.error('Erreur lors de la suppression du compte:', error);
    res.status(500).json({ message: 'Erreur lors de la suppression du compte' });
  }
};

/**
 * Met à jour uniquement l'email PayPal de l'utilisateur authentifié
 */
export const updatePayPalEmail = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = (req.user as any).id;
    const { paypalEmail, confirmPassword } = req.body;

    const newPayPalEmail = await setPayPalEmail(userId, paypalEmail, confirmPassword);

    res.status(200).json({
      message: 'Email PayPal mis à jour avec succès',
      paypalEmail: newPayPalEmail
    });
  } catch (error) {
    if (handleHttpError(res, error)) return;

    logger.error('Erreur lors de la mise à jour de l\'email PayPal:', error);
    res.status(500).json({ message: 'Erreur lors de la mise à jour de l\'email PayPal' });
  }
};

/**
 * Supprime l'email PayPal de l'utilisateur authentifié
 */
export const removePayPalEmail = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = (req.user as any).id;
    const { confirmPassword } = req.body;

    await clearPayPalEmail(userId, confirmPassword);

    res.status(200).json({
      message: 'Email PayPal supprimé avec succès'
    });
  } catch (error) {
    if (handleHttpError(res, error)) return;

    logger.error('Erreur lors de la suppression de l\'email PayPal:', error);
    res.status(500).json({ message: 'Erreur lors de la suppression de l\'email PayPal' });
  }
};
