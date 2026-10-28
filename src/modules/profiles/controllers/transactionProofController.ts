import { Request, Response } from 'express';
import { parsePagination } from '../../../commons/utils/pagination';
import { listUserProofs, submitTransactionProof, getVerificationStats } from '../services/transactionProofService';

const PROOFS_PAGE_SIZE = 10;

/**
 * Preuves de transaction d'un membre (vérifiées seulement, sauf pour leur auteur ou un admin)
 * @route GET /api/profiles/proofs/:userId
 */
export const getUserProofs = async (req: Request, res: Response): Promise<void> => {
  res.status(200).json(await listUserProofs({
    ownerId: String(req.params.userId),
    viewerId: req.user?.id,
    includeAll: Boolean(req.query.includeAll),
    pageRequest: parsePagination(req.query, { defaultLimit: PROOFS_PAGE_SIZE })
  }));
};

/**
 * Soumet une preuve de transaction
 * @route POST /api/profiles/proofs
 */
export const addTransactionProof = async (req: Request, res: Response): Promise<void> => {
  const proof = await submitTransactionProof(req.user!.id, req.body ?? {});

  res.status(201).json({
    message: 'Preuve de transaction soumise avec succès. Elle est en cours de vérification.',
    proof
  });
};

/**
 * Statistiques de preuves d'un membre
 * @route GET /api/profiles/verification-stats/:userId
 */
export const getUserVerificationStats = async (req: Request, res: Response): Promise<void> => {
  res.status(200).json(await getVerificationStats(String(req.params.userId)));
};
