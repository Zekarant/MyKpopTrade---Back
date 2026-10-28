import { Request, Response } from 'express';
import {
  updateConsents,
  buildUserDataExport,
  scheduleAccountDeletion,
  cancelAccountDeletion,
  anonymizeAccount
} from '../services/userPrivacyService';

/**
 * Met à jour les consentements de l'utilisateur
 * @route PUT /api/users/me/consents
 * @access Private
 */
export const updateUserConsents = async (req: Request, res: Response) => {
  const { privacyPolicy, dataProcessing, marketing } = req.body ?? {};
  const consents = await updateConsents(req.user!.id, { privacyPolicy, dataProcessing, marketing });

  return res.status(200).json({
    success: true,
    message: 'Consentements mis à jour avec succès',
    consents
  });
};

/**
 * Exporte les données personnelles de l'utilisateur (droit à la portabilité)
 * @route GET /api/users/me/data-export
 * @access Private
 */
export const exportUserData = async (req: Request, res: Response) => {
  const { userData, fileName } = await buildUserDataExport(req.user!.id);

  res.setHeader('Content-Disposition', `attachment; filename=${fileName}`);
  res.setHeader('Content-Type', 'application/json');
  return res.status(200).json(userData);
};

/**
 * Demande de suppression du compte utilisateur (droit à l'effacement)
 * @route POST /api/users/me/deletion-request
 * @access Private
 */
export const requestAccountDeletion = async (req: Request, res: Response) => {
  const scheduledDeletionDate = await scheduleAccountDeletion(req.user!.id, req.body?.confirmation);

  return res.status(200).json({
    success: true,
    message: 'Votre demande de suppression a été enregistrée',
    scheduledDeletionDate
  });
};

/**
 * Annule une demande de suppression de compte
 * @route DELETE /api/users/me/deletion-request
 * @access Private
 */
export const cancelDeletionRequest = async (req: Request, res: Response) => {
  await cancelAccountDeletion(req.user!.id);

  return res.status(200).json({
    success: true,
    message: 'Votre demande de suppression a été annulée avec succès'
  });
};

/**
 * Anonymise les données personnelles (alternative à la suppression)
 * @route POST /api/users/me/anonymize
 * @access Private
 */
export const anonymizeUserData = async (req: Request, res: Response) => {
  await anonymizeAccount(req.user!.id, req.body?.confirmation);

  return res.status(200).json({
    success: true,
    message: 'Vos données personnelles ont été anonymisées avec succès'
  });
};
