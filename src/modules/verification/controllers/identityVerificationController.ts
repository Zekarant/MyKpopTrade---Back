import { Request, Response } from 'express';
import {
  submitIdentityVerification,
  fetchVerificationStatus,
  approveIdentityVerification,
  rejectIdentityVerification,
  listPendingVerifications,
  cancelUserVerification,
  getVerificationDocumentForAdmin
} from '../services/identityVerificationService';
import { parsePagination } from '../../../commons/utils/pagination';

const PENDING_VERIFICATIONS_DEFAULT_LIMIT = 20;

/**
 * Soumettre une demande de vérification d'identité
 */
export const submitVerification = async (req: Request, res: Response) => {
  const { documentType, consentGiven } = req.body;

  const verification = await submitIdentityVerification({
    userId: req.user!.id,
    documentType,
    consentGiven,
    fileBuffer: req.file?.buffer,
    mimetype: req.file?.mimetype
  });

  res.status(201).json({
    message: 'Votre demande de vérification d\'identité a été soumise et sera traitée dans les plus brefs délais',
    verification
  });
};

/**
 * Vérifier le statut d'une demande de vérification
 */
export const checkVerificationStatus = async (req: Request, res: Response) => {
  const result = await fetchVerificationStatus(req.user!.id);
  res.status(200).json(result);
};

/**
 * Approuver une demande de vérification (accès administrateur)
 */
export const approveVerification = async (req: Request, res: Response) => {
  await approveIdentityVerification({
    verificationId: String(req.params.id || ''),
    adminId: req.user!.id
  });

  res.status(200).json({
    message: 'Demande de vérification approuvée avec succès'
  });
};

/**
 * Rejeter une demande de vérification (accès administrateur)
 */
export const rejectVerification = async (req: Request, res: Response) => {
  await rejectIdentityVerification({
    verificationId: String(req.params.id || ''),
    adminId: req.user!.id,
    reason: req.body.reason
  });

  res.status(200).json({
    message: 'Demande de vérification rejetée'
  });
};

/**
 * Liste des demandes de vérification en attente (accès administrateur)
 */
export const getPendingVerifications = async (req: Request, res: Response) => {
  const { page, limit } = parsePagination(req.query, { defaultLimit: PENDING_VERIFICATIONS_DEFAULT_LIMIT });
  const result = await listPendingVerifications(req.user!.id, page, limit);
  res.status(200).json(result);
};

/**
 * Affiche le document d'une demande en attente (accès administrateur).
 * no-store : une pièce d'identité ne doit rester dans aucun cache.
 */
export const getVerificationDocument = async (req: Request, res: Response) => {
  const { buffer, contentType } = await getVerificationDocumentForAdmin(String(req.params.id || ''), req.user!.id);

  res.set({
    'Content-Type': contentType,
    'Content-Disposition': 'inline',
    'Cache-Control': 'no-store, private',
    'X-Content-Type-Options': 'nosniff'
  });
  res.status(200).send(buffer);
};

/**
 * Annuler une demande de vérification
 */
export const cancelVerification = async (req: Request, res: Response) => {
  await cancelUserVerification(req.user!.id);

  res.status(200).json({
    message: 'Votre demande de vérification a été annulée avec succès'
  });
};
