import { Request, Response } from 'express';
import followService from './service';

export const toggleFollow = async (req: Request, res: Response) => {
  try {
    const userId = (req.user as any).id;
    const targetUserId = req.params.targetUserId as string;

    const result = await followService.toggleFollow(userId, targetUserId);
    return res.status(200).json({
      message: result.isFollowing ? 'Utilisateur suivi' : 'Utilisateur non suivi',
      ...result
    });
  } catch (error: any) {
    return res.status(400).json({ message: error.message });
  }
};

export const getFollowStatus = async (req: Request, res: Response) => {
  try {
    const userId = (req.user as any).id;
    const targetUserId = req.params.targetUserId as string;

    const isFollowing = await followService.isFollowing(userId, targetUserId);
    const counts = await followService.getCounts(targetUserId);

    return res.status(200).json({ isFollowing, ...counts });
  } catch (error: any) {
    return res.status(500).json({ message: error.message });
  }
};

export const getFollowers = async (req: Request, res: Response) => {
  try {
    const userId = req.params.userId as string;
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;

    const result = await followService.getFollowers(userId, page, limit);
    return res.status(200).json(result);
  } catch (error: any) {
    return res.status(500).json({ message: error.message });
  }
};

export const getFollowing = async (req: Request, res: Response) => {
  try {
    const userId = req.params.userId as string;
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;

    const result = await followService.getFollowing(userId, page, limit);
    return res.status(200).json(result);
  } catch (error: any) {
    return res.status(500).json({ message: error.message });
  }
};

export const getFriends = async (req: Request, res: Response) => {
  try {
    const userId = (req.user as any).id;
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;

    const result = await followService.getMutualFollows(userId, page, limit);
    return res.status(200).json(result);
  } catch (error: any) {
    return res.status(500).json({ message: error.message });
  }
};

export const getMyCounts = async (req: Request, res: Response) => {
  try {
    const userId = (req.user as any).id;
    const counts = await followService.getCounts(userId);
    return res.status(200).json(counts);
  } catch (error: any) {
    return res.status(500).json({ message: error.message });
  }
};

export const removeFollower = async (req: Request, res: Response) => {
  try {
    const userId = (req.user as any).id;
    const followerId = req.params.followerId as string;

    const result = await followService.removeFollower(userId, followerId);
    return res.status(200).json({ message: 'Abonné retiré', ...result });
  } catch (error: any) {
    return res.status(400).json({ message: error.message });
  }
};
