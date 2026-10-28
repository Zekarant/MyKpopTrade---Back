import mongoose from 'mongoose';
import { Request, Response } from 'express';
import { notFound } from '../../../commons/utils/httpError';
import { parsePagination } from '../../../commons/utils/pagination';
import logger from '../../../commons/utils/logger';
import {
  blockUser,
  unblockUser,
  getBlockStatus,
  listBlockedUsers
} from '../services/userBlockService';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

/**
 * Identifiant de membre de l'URL. Un identifiant invalide ne peut désigner
 * aucun compte : 404, comme un membre inexistant.
 */
function targetUserId(req: Request): string {
  const id = req.params.id;
  if (typeof id !== 'string' || !mongoose.Types.ObjectId.isValid(id)) {
    throw notFound('Utilisateur introuvable');
  }
  return id;
}

/**
 * Bloque un membre
 * @route POST /api/users/:id/block
 */
export const blockUserHandler = async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const targetId = targetUserId(req);

  await blockUser(userId, targetId);

  logger.info('user.blocked', { userId, targetId });
  return res.status(200).json({ message: 'Utilisateur bloqué', blockedByMe: true });
};

/**
 * Débloque un membre
 * @route DELETE /api/users/:id/block
 */
export const unblockUserHandler = async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const targetId = targetUserId(req);

  await unblockUser(userId, targetId);

  logger.info('user.unblocked', { userId, targetId });
  return res.status(200).json({ message: 'Utilisateur débloqué', blockedByMe: false });
};

/**
 * Situation de blocage avec un membre (pour afficher « Bloquer » ou « Débloquer »)
 * @route GET /api/users/:id/block
 */
export const getBlockStatusHandler = async (req: Request, res: Response) => {
  return res.status(200).json(await getBlockStatus(req.user!.id, targetUserId(req)));
};

/**
 * Membres que j'ai bloqués
 * @route GET /api/users/me/blocked
 */
export const listBlockedUsersHandler = async (req: Request, res: Response) => {
  const pageRequest = parsePagination(req.query, { defaultLimit: DEFAULT_PAGE_SIZE, maxLimit: MAX_PAGE_SIZE });
  return res.status(200).json(await listBlockedUsers(req.user!.id, pageRequest));
};
