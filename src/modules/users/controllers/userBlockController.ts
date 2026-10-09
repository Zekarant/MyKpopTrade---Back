import mongoose from 'mongoose';
import { Request, Response } from 'express';
import { asyncHandler } from '../../../commons/middlewares/errorMiddleware';
import { mapHttpError } from '../../../commons/utils/httpErrorMapper';
import { clampLimit } from '../../../commons/utils/pagination';
import { queryInt } from '../../../commons/utils/query';
import logger from '../../../commons/utils/logger';
import {
  blockUser,
  unblockUser,
  getBlockStatus,
  listBlockedUsers
} from '../services/userBlockService';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

/** Identifiant de membre de l'URL, ou null s'il ne peut désigner aucun compte. */
function targetUserId(req: Request): string | null {
  const id = req.params.id;
  return typeof id === 'string' && mongoose.Types.ObjectId.isValid(id) ? id : null;
}

const userNotFound = (res: Response) => res.status(404).json({ message: 'Utilisateur introuvable' });

/**
 * Bloque un membre
 * @route POST /api/users/:id/block
 */
export const blockUserHandler = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const targetId = targetUserId(req);
  if (!targetId) return userNotFound(res);

  try {
    await blockUser(userId, targetId);
  } catch (error) {
    const mapped = mapHttpError(res, error);
    if (mapped) return mapped;
    throw error;
  }

  logger.info('user.blocked', { userId, targetId });
  return res.status(200).json({ message: 'Utilisateur bloqué', blockedByMe: true });
});

/**
 * Débloque un membre
 * @route DELETE /api/users/:id/block
 */
export const unblockUserHandler = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const targetId = targetUserId(req);
  if (!targetId) return userNotFound(res);

  await unblockUser(userId, targetId);

  logger.info('user.unblocked', { userId, targetId });
  return res.status(200).json({ message: 'Utilisateur débloqué', blockedByMe: false });
});

/**
 * Situation de blocage avec un membre (pour afficher « Bloquer » ou « Débloquer »)
 * @route GET /api/users/:id/block
 */
export const getBlockStatusHandler = asyncHandler(async (req: Request, res: Response) => {
  const targetId = targetUserId(req);
  if (!targetId) return userNotFound(res);

  return res.status(200).json(await getBlockStatus(req.user!.id, targetId));
});

/**
 * Membres que j'ai bloqués
 * @route GET /api/users/me/blocked
 */
export const listBlockedUsersHandler = asyncHandler(async (req: Request, res: Response) => {
  const page = Math.max(1, queryInt(req.query.page) || 1);
  const limit = clampLimit(req.query.limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

  return res.status(200).json(await listBlockedUsers(req.user!.id, page, limit));
});
