import mongoose from 'mongoose';
import { Request, Response } from 'express';
import * as followService from '../services/followService';
import { notFound } from '../../../commons/utils/httpError';
import { parsePagination } from '../../../commons/utils/pagination';

const PAGE_OPTIONS = { defaultLimit: 20, maxLimit: 50 };

/** Identifiant de membre lu dans l'URL ; un identifiant mal formé ne désigne personne (404). */
function readUserId(value: unknown, message = 'Utilisateur introuvable'): string {
  if (typeof value !== 'string' || !mongoose.Types.ObjectId.isValid(value)) {
    throw notFound(message);
  }
  return value;
}

export const toggleFollow = async (req: Request, res: Response) => {
  const targetUserId = readUserId(req.params.targetUserId);
  const result = await followService.toggleFollow(req.user!.id, targetUserId);
  return res.status(200).json({
    message: result.isFollowing ? 'Utilisateur suivi' : 'Utilisateur non suivi',
    ...result
  });
};

export const getFollowStatus = async (req: Request, res: Response) => {
  const targetUserId = readUserId(req.params.targetUserId);
  const [isFollowing, counts] = await Promise.all([
    followService.isFollowing(req.user!.id, targetUserId),
    followService.getCounts(targetUserId)
  ]);
  return res.status(200).json({ isFollowing, ...counts });
};

export const getFollowers = async (req: Request, res: Response) => {
  const userId = readUserId(req.params.userId);
  return res.status(200).json(await followService.getFollowers(userId, parsePagination(req.query, PAGE_OPTIONS)));
};

export const getFollowing = async (req: Request, res: Response) => {
  const userId = readUserId(req.params.userId);
  return res.status(200).json(await followService.getFollowing(userId, parsePagination(req.query, PAGE_OPTIONS)));
};

export const getFriends = async (req: Request, res: Response) => {
  return res.status(200).json(
    await followService.getMutualFollows(req.user!.id, parsePagination(req.query, PAGE_OPTIONS))
  );
};

export const getMyCounts = async (req: Request, res: Response) => {
  return res.status(200).json(await followService.getCounts(req.user!.id));
};

export const removeFollower = async (req: Request, res: Response) => {
  const followerId = readUserId(req.params.followerId, 'Cet utilisateur ne vous suit pas');
  const result = await followService.removeFollower(req.user!.id, followerId);
  return res.status(200).json({ message: 'Abonné retiré', ...result });
};
