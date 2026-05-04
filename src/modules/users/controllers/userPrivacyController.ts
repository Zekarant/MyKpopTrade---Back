import { Request, Response, NextFunction } from 'express';
import { asyncHandler } from '../../../commons/middlewares/errorMiddleware';
import logger from '../../../commons/utils/logger';
import { HttpError } from '../../../commons/utils/httpError';
import {
  updateConsents,
  buildUserDataExport,
  scheduleAccountDeletion,
  cancelAccountDeletion,
  anonymizeAccount
} from '../services/userPrivacyService';

function mapHttpError(res: Response, error: unknown, successFalse = true): Response | null {
  if (error instanceof HttpError) {
    const body: any = { message: error.message };
    if (successFalse) body.success = false;
    return res.status(error.statusCode).json(body);
  }
  return null;
}

function requireUserId(req: Request, res: Response, message: string): string | null {
  const userId = (req.user as any)?.id;
  if (!userId) {
    res.status(401).json({
      success: false,
      message
    });
    return null;
  }
  return userId;
}

/**
 * Met à jour les consentements de l'utilisateur
 * @route PUT /api/users/me/consents
 * @access Private
 */
export const updateUserConsents = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  const userId = requireUserId(req, res, 'Vous devez être connecté pour mettre à jour vos consentements');
  if (!userId) return;

  const { privacyPolicy, dataProcessing, marketing } = req.body;

  try {
    const consents = await updateConsents(userId, { privacyPolicy, dataProcessing, marketing });

    return res.status(200).json({
      success: true,
      message: 'Consentements mis à jour avec succès',
      consents
    });
  } catch (error) {
    const mapped = mapHttpError(res, error);
    if (mapped) return mapped;

    logger.error('Erreur lors de la mise à jour des consentements', {
      error: error instanceof Error ? error.message : String(error),
      userId: userId.substring(0, 5) + '...'
    });

    next(error);
  }
});

/**
 * Exporte les données personnelles de l'utilisateur (droit à la portabilité)
 * @route GET /api/users/me/data-export
 * @access Private
 */
export const exportUserData = asyncHandler(async (req: Request, res: Response) => {
  const userId = requireUserId(req, res, 'Vous devez être connecté pour exporter vos données');
  if (!userId) return;

  try {
    const { userData, fileName } = await buildUserDataExport(userId);

    res.setHeader('Content-Disposition', `attachment; filename=${fileName}`);
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json(userData);
  } catch (error) {
    const mapped = mapHttpError(res, error);
    if (mapped) return mapped;

    logger.error('Erreur lors de l\'export des données personnelles', {
      error: error instanceof Error ? error.message : String(error),
      userId: userId.substring(0, 5) + '...'
    });

    return res.status(500).json({
      success: false,
      message: 'Une erreur est survenue lors de l\'export de vos données personnelles'
    });
  }
});

/**
 * Demande de suppression du compte utilisateur (droit à l'effacement)
 * @route POST /api/users/me/deletion-request
 * @access Private
 */
export const requestAccountDeletion = asyncHandler(async (req: Request, res: Response) => {
  const userId = requireUserId(req, res, 'Vous devez être connecté pour demander la suppression de votre compte');
  if (!userId) return;

  try {
    const scheduledDeletionDate = await scheduleAccountDeletion(userId, req.body.confirmation);

    return res.status(200).json({
      success: true,
      message: 'Votre demande de suppression a été enregistrée',
      scheduledDeletionDate
    });
  } catch (error) {
    const mapped = mapHttpError(res, error);
    if (mapped) return mapped;

    logger.error('Erreur lors de la demande de suppression de compte', {
      error: error instanceof Error ? error.message : String(error),
      userId: userId.substring(0, 5) + '...'
    });

    return res.status(500).json({
      success: false,
      message: 'Une erreur est survenue lors du traitement de votre demande'
    });
  }
});

/**
 * Annule une demande de suppression de compte
 * @route DELETE /api/users/me/deletion-request
 * @access Private
 */
export const cancelDeletionRequest = asyncHandler(async (req: Request, res: Response) => {
  const userId = requireUserId(req, res, 'Vous devez être connecté pour annuler une demande de suppression');
  if (!userId) return;

  try {
    await cancelAccountDeletion(userId);

    return res.status(200).json({
      success: true,
      message: 'Votre demande de suppression a été annulée avec succès'
    });
  } catch (error) {
    const mapped = mapHttpError(res, error);
    if (mapped) return mapped;

    logger.error('Erreur lors de l\'annulation de la demande de suppression', {
      error: error instanceof Error ? error.message : String(error),
      userId: userId.substring(0, 5) + '...'
    });

    return res.status(500).json({
      success: false,
      message: 'Une erreur est survenue lors de l\'annulation de votre demande'
    });
  }
});

/**
 * Anonymise les données personnelles (alternative à la suppression)
 * @route POST /api/users/me/anonymize
 * @access Private
 */
export const anonymizeUserData = asyncHandler(async (req: Request, res: Response) => {
  const userId = requireUserId(req, res, 'Vous devez être connecté pour anonymiser vos données');
  if (!userId) return;

  try {
    await anonymizeAccount(userId, req.body.confirmation);

    return res.status(200).json({
      success: true,
      message: 'Vos données personnelles ont été anonymisées avec succès'
    });
  } catch (error) {
    const mapped = mapHttpError(res, error);
    if (mapped) return mapped;

    logger.error('Erreur lors de l\'anonymisation des données', {
      error: error instanceof Error ? error.message : String(error),
      userId: userId.substring(0, 5) + '...'
    });

    return res.status(500).json({
      success: false,
      message: 'Une erreur est survenue lors de l\'anonymisation de vos données'
    });
  }
});
