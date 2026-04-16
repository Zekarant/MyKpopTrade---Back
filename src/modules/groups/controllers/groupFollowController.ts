import { Request, Response } from 'express';
import { asyncHandler } from '../../../commons/middlewares/errorMiddleware';
import logger from '../../../commons/utils/logger';
import { HttpError } from '../../../commons/utils/httpError';
import {
  toggleFollow,
  getFollowStatusForUser,
  listFollowedGroups,
  listGroupFollowers
} from '../services/groupFollowService';

interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: string;
  };
}

interface FollowResponse {
  message: string;
  isFollowing: boolean;
  followersCount: number;
}

interface FollowStatusResponse {
  groupId: string;
  groupName: string;
  isFollowing: boolean;
  followersCount: number;
}

interface UserFollowedGroupsResponse {
  groups: any[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    pages: number;
  };
}

/**
 * Suivre ou arrêter de suivre un groupe
 */
export const toggleFollowGroup = asyncHandler(async (req: AuthenticatedRequest, res: Response<FollowResponse>) => {
  const groupId = req.params.groupId as string;
  const userId = req.user?.id;

  if (!userId) {
    return res.status(401).json({
      message: 'Authentification requise',
      isFollowing: false,
      followersCount: 0
    });
  }

  try {
    const result = await toggleFollow(userId, groupId);
    return res.status(200).json(result);
  } catch (error) {
    if (error instanceof HttpError) {
      return res.status(error.statusCode).json({
        message: error.message,
        isFollowing: false,
        followersCount: 0
      });
    }

    logger.error('Erreur lors du suivi du groupe', {
      error: error instanceof Error ? error.message : 'Erreur inconnue',
      stack: error instanceof Error ? error.stack : undefined,
      groupId,
      userId
    });

    return res.status(500).json({
      message: 'Une erreur est survenue lors de la modification du suivi',
      isFollowing: false,
      followersCount: 0
    });
  }
});

/**
 * Vérifier si l'utilisateur suit un groupe
 */
export const getFollowStatus = asyncHandler(async (req: AuthenticatedRequest, res: Response<FollowStatusResponse>) => {
  const groupId = req.params.groupId as string;
  const userId = req.user?.id;

  if (!userId) {
    return res.status(401).json({
      message: 'Authentification requise',
      groupId,
      groupName: '',
      isFollowing: false,
      followersCount: 0
    } as any);
  }

  try {
    const result = await getFollowStatusForUser(userId, groupId);
    return res.status(200).json(result);
  } catch (error) {
    if (error instanceof HttpError) {
      const groupName = (error as any).groupName ?? '';
      const followersCount = (error as any).followersCount ?? 0;
      return res.status(error.statusCode).json({
        message: error.message,
        groupId,
        groupName,
        isFollowing: false,
        followersCount
      } as any);
    }

    logger.error('Erreur lors de la vérification du statut de suivi', {
      error: error instanceof Error ? error.message : 'Erreur inconnue',
      groupId,
      userId
    });

    return res.status(500).json({
      message: 'Une erreur est survenue',
      groupId,
      groupName: '',
      isFollowing: false,
      followersCount: 0
    } as any);
  }
});

/**
 * Récupérer les groupes suivis par l'utilisateur
 */
export const getUserFollowedGroups = asyncHandler(async (req: AuthenticatedRequest, res: Response<UserFollowedGroupsResponse>) => {
  const userId = req.user?.id;
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;

  if (!userId) {
    return res.status(401).json({
      message: 'Authentification requise',
      groups: [],
      pagination: { page, limit, total: 0, pages: 0 }
    } as any);
  }

  try {
    const result = await listFollowedGroups(userId, page, limit);
    return res.status(200).json(result);
  } catch (error) {
    if (error instanceof HttpError) {
      return res.status(error.statusCode).json({
        message: error.message,
        groups: [],
        pagination: { page, limit, total: 0, pages: 0 }
      } as any);
    }

    logger.error('Erreur lors de la récupération des groupes suivis', {
      error: error instanceof Error ? error.message : 'Erreur inconnue',
      userId
    });

    return res.status(500).json({
      message: 'Une erreur est survenue',
      groups: [],
      pagination: { page, limit, total: 0, pages: 0 }
    } as any);
  }
});

/**
 * Récupérer les followers d'un groupe
 */
export const getGroupFollowers = asyncHandler(async (req: Request, res: Response) => {
  const groupId = req.params.groupId as string;
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;

  try {
    const result = await listGroupFollowers(groupId, page, limit);
    return res.status(200).json(result);
  } catch (error) {
    if (error instanceof HttpError) {
      return res.status(error.statusCode).json({ message: error.message });
    }

    logger.error('Erreur lors de la récupération des followers', {
      error: error instanceof Error ? error.message : 'Erreur inconnue',
      groupId
    });

    return res.status(500).json({
      message: 'Une erreur est survenue'
    });
  }
});
