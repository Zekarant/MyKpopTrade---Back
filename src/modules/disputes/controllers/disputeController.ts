import { Request, Response } from 'express';
import { asyncHandler } from '../../../commons/middlewares/errorMiddleware';
import { HttpError } from '../../../commons/utils/httpError';
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
import logger from '../../../commons/utils/logger';
import User from '../../../models/userModel';

function replyHttpError(res: Response, error: HttpError) {
  return res.status(error.statusCode).json({
    success: false,
    message: error.message,
    ...(error.code ? { code: error.code } : {})
  });
}

async function isAdmin(userId: string): Promise<boolean> {
  const user = await User.findById(userId).select('role').lean<{ role?: string } | null>();
  return Boolean(user && user.role === 'admin');
}

/** POST /api/disputes — Ouvre un litige sur un paiement. */
export const create = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const { paymentId, reason, description, evidence } = req.body;
  try {
    const dispute = await openDispute({ userId, paymentId, reason, description, evidence });
    return res.status(201).json({ success: true, dispute });
  } catch (error) {
    if (error instanceof HttpError) return replyHttpError(res, error);
    logger.error('Erreur création litige', {
      error: error instanceof Error ? error.message : String(error)
    });
    return res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

/** GET /api/disputes/me — Liste paginée des litiges où l'utilisateur est partie. */
export const listMine = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 10;
  const result = await listMyDisputes(userId, page, limit);
  return res.status(200).json({ success: true, ...result });
});

/** GET /api/disputes/:id — Détail d'un litige (acheteur, vendeur ou admin). */
export const getOne = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const admin = await isAdmin(userId);
  try {
    const dispute = await getDispute(userId, req.params.id as string, admin);
    return res.status(200).json({ success: true, dispute });
  } catch (error) {
    if (error instanceof HttpError) return replyHttpError(res, error);
    return res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

/** POST /api/disputes/:id/messages — Ajoute un message au litige. */
export const addMessage = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const admin = await isAdmin(userId);
  try {
    const dispute = await addDisputeMessage({
      userId,
      disputeId: req.params.id as string,
      content: req.body?.content,
      attachments: req.body?.attachments,
      isAdmin: admin
    });
    return res.status(200).json({ success: true, dispute });
  } catch (error) {
    if (error instanceof HttpError) return replyHttpError(res, error);
    return res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

/** POST /api/disputes/:id/cancel — Le plaignant retire son litige. */
export const cancel = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  try {
    const dispute = await cancelDispute(userId, req.params.id as string);
    return res.status(200).json({ success: true, dispute });
  } catch (error) {
    if (error instanceof HttpError) return replyHttpError(res, error);
    return res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

/* ----------------------- Routes administrateur ------------------------- */

/** GET /api/disputes — Admin : liste tous les litiges, filtrable par status. */
export const adminList = asyncHandler(async (req: Request, res: Response) => {
  const status = req.query.status as string | undefined;
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;
  const result = await listAllDisputes({ status, page, limit });
  return res.status(200).json({ success: true, ...result });
});

/** POST /api/disputes/:id/take — Admin : passe le litige en under_review. */
export const adminTake = asyncHandler(async (req: Request, res: Response) => {
  const adminId = (req.user as any).id;
  try {
    const dispute = await takeDisputeUnderReview(adminId, req.params.id as string);
    return res.status(200).json({ success: true, dispute });
  } catch (error) {
    if (error instanceof HttpError) return replyHttpError(res, error);
    return res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

/** POST /api/disputes/:id/resolve — Admin : tranche le litige. */
export const adminResolve = asyncHandler(async (req: Request, res: Response) => {
  const adminId = (req.user as any).id;
  try {
    const dispute = await resolveDispute({
      adminId,
      disputeId: req.params.id as string,
      outcome: req.body?.outcome,
      notes: req.body?.notes,
      refundAmount: req.body?.refundAmount
    });
    return res.status(200).json({ success: true, dispute });
  } catch (error) {
    if (error instanceof HttpError) return replyHttpError(res, error);
    return res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});
