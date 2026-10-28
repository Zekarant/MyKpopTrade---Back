import { Request, Response } from 'express';
import {
  openDispute,
  addDisputeMessage,
  cancelDispute,
  takeDisputeUnderReview,
  resolveDispute,
  getDispute,
  listMyDisputes,
  listAllDisputes
} from '../services/disputeService';
import { parsePagination } from '../../../commons/utils/pagination';
import { queryString } from '../../../commons/utils/query';

const MY_DISPUTES_PAGE = { defaultLimit: 10, maxLimit: 50 };
const ADMIN_DISPUTES_PAGE = { defaultLimit: 20, maxLimit: 100 };

/** POST /api/disputes — Ouvre un litige sur un paiement. */
export const create = async (req: Request, res: Response) => {
  const { paymentId, reason, description, evidence } = req.body;
  const dispute = await openDispute({ userId: req.user!.id, paymentId, reason, description, evidence });
  res.status(201).json({ success: true, dispute });
};

/** GET /api/disputes/me — Liste paginée des litiges où l'utilisateur est partie. */
export const listMine = async (req: Request, res: Response) => {
  const result = await listMyDisputes(req.user!.id, parsePagination(req.query, MY_DISPUTES_PAGE));
  res.status(200).json({ success: true, ...result });
};

/** GET /api/disputes/:id — Détail d'un litige (acheteur, vendeur ou admin). */
export const getOne = async (req: Request, res: Response) => {
  const dispute = await getDispute(req.user!.id, req.params.id as string);
  res.status(200).json({ success: true, dispute });
};

/** POST /api/disputes/:id/messages — Ajoute un message au litige. */
export const addMessage = async (req: Request, res: Response) => {
  const dispute = await addDisputeMessage({
    userId: req.user!.id,
    disputeId: req.params.id as string,
    content: req.body?.content,
    attachments: req.body?.attachments
  });
  res.status(200).json({ success: true, dispute });
};

/** POST /api/disputes/:id/cancel — Le plaignant retire son litige. */
export const cancel = async (req: Request, res: Response) => {
  const dispute = await cancelDispute(req.user!.id, req.params.id as string);
  res.status(200).json({ success: true, dispute });
};

/* ----------------------- Routes administrateur ------------------------- */

/** GET /api/disputes — Admin : liste tous les litiges, filtrable par status. */
export const adminList = async (req: Request, res: Response) => {
  const result = await listAllDisputes(
    queryString(req.query.status),
    parsePagination(req.query, ADMIN_DISPUTES_PAGE)
  );
  res.status(200).json({ success: true, ...result });
};

/** POST /api/disputes/:id/take — Admin : passe le litige en under_review. */
export const adminTake = async (req: Request, res: Response) => {
  const dispute = await takeDisputeUnderReview(req.user!.id, req.params.id as string);
  res.status(200).json({ success: true, dispute });
};

/** POST /api/disputes/:id/resolve — Admin : tranche le litige. */
export const adminResolve = async (req: Request, res: Response) => {
  const dispute = await resolveDispute({
    adminId: req.user!.id,
    disputeId: req.params.id as string,
    outcome: req.body?.outcome,
    notes: req.body?.notes,
    refundAmount: req.body?.refundAmount
  });
  res.status(200).json({ success: true, dispute });
};
