import mongoose from 'mongoose';
import { Request, Response } from 'express';
import followService, { FollowTargetNotFoundError } from './service';
import { clampLimit } from '../../commons/utils/pagination';
import logger from '../../commons/utils/logger';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

function pagination(req: Request) {
  return {
    page: Math.max(1, parseInt(req.query.page as string) || 1),
    limit: clampLimit(req.query.limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)
  };
}

const isObjectId = (value: unknown): value is string =>
  typeof value === 'string' && mongoose.Types.ObjectId.isValid(value);

/** Erreur inattendue : journalisée, sans renvoyer son message interne au client. */
function serverError(res: Response, action: string, error: unknown) {
  logger.error(`Abonnements : ${action} impossible`, {
    error: error instanceof Error ? error.message : String(error)
  });
  return res.status(500).json({ message: 'Erreur serveur' });
}

export const toggleFollow = async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const targetUserId = req.params.targetUserId;
  if (!isObjectId(targetUserId)) {
    return res.status(404).json({ message: 'Utilisateur introuvable' });
  }
  if (targetUserId === userId) {
    return res.status(400).json({ message: 'Vous ne pouvez pas vous suivre vous-même' });
  }

  try {
    const result = await followService.toggleFollow(userId, targetUserId);
    return res.status(200).json({
      message: result.isFollowing ? 'Utilisateur suivi' : 'Utilisateur non suivi',
      ...result
    });
  } catch (error) {
    if (error instanceof FollowTargetNotFoundError) {
      return res.status(404).json({ message: error.message });
    }
    return serverError(res, 'abonnement', error);
  }
};

export const getFollowStatus = async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const targetUserId = req.params.targetUserId;
  if (!isObjectId(targetUserId)) {
    return res.status(404).json({ message: 'Utilisateur introuvable' });
  }

  try {
    const [isFollowing, counts] = await Promise.all([
      followService.isFollowing(userId, targetUserId),
      followService.getCounts(targetUserId)
    ]);
    return res.status(200).json({ isFollowing, ...counts });
  } catch (error) {
    return serverError(res, 'statut', error);
  }
};

export const getFollowers = async (req: Request, res: Response) => {
  const userId = req.params.userId;
  if (!isObjectId(userId)) {
    return res.status(404).json({ message: 'Utilisateur introuvable' });
  }
  const { page, limit } = pagination(req);

  try {
    return res.status(200).json(await followService.getFollowers(userId, page, limit));
  } catch (error) {
    return serverError(res, 'liste des abonnés', error);
  }
};

export const getFollowing = async (req: Request, res: Response) => {
  const userId = req.params.userId;
  if (!isObjectId(userId)) {
    return res.status(404).json({ message: 'Utilisateur introuvable' });
  }
  const { page, limit } = pagination(req);

  try {
    return res.status(200).json(await followService.getFollowing(userId, page, limit));
  } catch (error) {
    return serverError(res, 'liste des abonnements', error);
  }
};

export const getFriends = async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { page, limit } = pagination(req);

  try {
    return res.status(200).json(await followService.getMutualFollows(userId, page, limit));
  } catch (error) {
    return serverError(res, 'liste des amis', error);
  }
};

export const getMyCounts = async (req: Request, res: Response) => {
  const userId = req.user!.id;

  try {
    return res.status(200).json(await followService.getCounts(userId));
  } catch (error) {
    return serverError(res, 'compteurs', error);
  }
};

export const removeFollower = async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const followerId = req.params.followerId;
  if (!isObjectId(followerId)) {
    return res.status(404).json({ message: 'Cet utilisateur ne vous suit pas' });
  }

  try {
    const result = await followService.removeFollower(userId, followerId);
    return res.status(200).json({ message: 'Abonné retiré', ...result });
  } catch (error: any) {
    // removeFollower ne lève que « cet utilisateur ne vous suit pas ».
    return res.status(404).json({ message: error.message });
  }
};
