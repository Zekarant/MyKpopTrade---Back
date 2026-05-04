import { Request, Response } from 'express';
import { asyncHandler } from '../../../commons/middlewares/errorMiddleware';
import { mapHttpError } from '../../../commons/utils/httpErrorMapper';
import {
  submitIdentityVerification,
  fetchVerificationStatus,
  approveIdentityVerification,
  rejectIdentityVerification,
  listPendingVerifications,
  cancelUserVerification
} from '../services/identityVerificationService';

/**
 * Soumettre une demande de vérification d'identité
 */
export const submitVerification = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const { documentType, consentGiven } = req.body;

  try {
    const verification = await submitIdentityVerification({
      userId,
      documentType,
      consentGiven,
      fileBuffer: req.file?.buffer,
      mimetype: req.file?.mimetype
    });

    return res.status(201).json({
      message: 'Votre demande de vérification d\'identité a été soumise et sera traitée dans les plus brefs délais',
      verification
    });
  } catch (error) {
    const mapped = mapHttpError(res, error);
    if (mapped) return mapped;
    throw error;
  }
});

/**
 * Vérifier le statut d'une demande de vérification
 */
export const checkVerificationStatus = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;

  try {
    const result = await fetchVerificationStatus(userId);
    return res.status(200).json(result);
  } catch (error) {
    const mapped = mapHttpError(res, error);
    if (mapped) return mapped;
    throw error;
  }
});

/**
 * Approuver une demande de vérification (accès administrateur)
 */
export const approveVerification = asyncHandler(async (req: Request, res: Response) => {
  const verificationId = String(req.params.id || req.params.verificationId || '');
  const adminId = (req.user as any).id;

  try {
    await approveIdentityVerification({ verificationId, adminId });
    return res.status(200).json({
      message: 'Demande de vérification approuvée avec succès'
    });
  } catch (error) {
    const mapped = mapHttpError(res, error);
    if (mapped) return mapped;
    throw error;
  }
});

/**
 * Rejeter une demande de vérification (accès administrateur)
 */
export const rejectVerification = asyncHandler(async (req: Request, res: Response) => {
  const verificationId = String(req.params.id || req.params.verificationId || '');
  const adminId = (req.user as any).id;
  const { reason } = req.body;

  try {
    await rejectIdentityVerification({ verificationId, adminId, reason });
    return res.status(200).json({
      message: 'Demande de vérification rejetée'
    });
  } catch (error) {
    const mapped = mapHttpError(res, error);
    if (mapped) return mapped;
    throw error;
  }
});

/**
 * Liste des demandes de vérification en attente (accès administrateur)
 */
export const getPendingVerifications = asyncHandler(async (req: Request, res: Response) => {
  const adminId = (req.user as any).id;
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;

  try {
    const result = await listPendingVerifications(adminId, page, limit);
    return res.status(200).json(result);
  } catch (error) {
    const mapped = mapHttpError(res, error);
    if (mapped) return mapped;
    throw error;
  }
});

/**
 * Annuler une demande de vérification
 */
export const cancelVerification = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;

  try {
    await cancelUserVerification(userId);
    return res.status(200).json({
      message: 'Votre demande de vérification a été annulée avec succès'
    });
  } catch (error) {
    const mapped = mapHttpError(res, error);
    if (mapped) return mapped;
    throw error;
  }
});
