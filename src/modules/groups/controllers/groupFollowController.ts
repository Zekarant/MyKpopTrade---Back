import { Request, Response } from 'express';
import mongoose from 'mongoose';
import KpopGroup from '../../../models/kpopGroupModel';
import User from '../../../models/userModel';
import { asyncHandler } from '../../../commons/middlewares/errorMiddleware';
import logger from '../../../commons/utils/logger';

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
  const { groupId } = req.params;
  const userId = req.user?.id;
  
  if (!userId) {
    return res.status(401).json({ 
      message: 'Authentification requise',
      isFollowing: false,
      followersCount: 0
    });
  }
  
  if (!mongoose.Types.ObjectId.isValid(groupId)) {
    return res.status(400).json({ 
      message: 'ID de groupe invalide',
      isFollowing: false,
      followersCount: 0
    });
  }
  
  try {
    const [group, user] = await Promise.all([
      KpopGroup.findById(groupId),
      User.findById(userId)
    ]);
    
    if (!group) {
      return res.status(404).json({ 
        message: 'Groupe non trouvé',
        isFollowing: false,
        followersCount: 0
      });
    }
    
    if (!user) {
      return res.status(404).json({ 
        message: 'Utilisateur non trouvé',
        isFollowing: false,
        followersCount: 0
      });
    }
    
    const groupObjectId = new mongoose.Types.ObjectId(groupId);
    const userObjectId = new mongoose.Types.ObjectId(userId);
    
    const isCurrentlyFollowing = user.followedGroups?.some((id: mongoose.Types.ObjectId) => 
      id.equals(groupObjectId)
    ) || false;
    
    let isFollowing: boolean;
    let message: string;
    
    if (isCurrentlyFollowing) {
      logger.info('Tentative d\'arrêt de suivi', { userId, groupId, groupName: group.name });
      
      const [userUpdate, groupUpdate] = await Promise.all([
        User.findByIdAndUpdate(
          userId,
          {
            $pull: { followedGroups: groupObjectId },
            $inc: { followedGroupsCount: -1 }
          },
          { new: true }
        ),
        KpopGroup.findByIdAndUpdate(
          groupId,
          {
            $pull: { followers: userObjectId },
            $inc: { followersCount: -1 }
          },
          { new: true }
        )
      ]);
      
      isFollowing = false;
      message = 'Vous ne suivez plus ce groupe';
      
      logger.info('Arrêt de suivi effectué', { 
        userId, 
        groupId, 
        userUpdate: !!userUpdate,
        groupUpdate: !!groupUpdate,
        newFollowersCount: groupUpdate?.followersCount
      });
      
    } else {
      logger.info('Tentative de suivi', { userId, groupId, groupName: group.name });
      
      const [userUpdate, groupUpdate] = await Promise.all([
        User.findByIdAndUpdate(
          userId,
          {
            $addToSet: { followedGroups: groupObjectId },
            $inc: { followedGroupsCount: 1 }
          },
          { new: true }
        ),
        KpopGroup.findByIdAndUpdate(
          groupId,
          {
            $addToSet: { followers: userObjectId },
            $inc: { followersCount: 1 }
          },
          { new: true }
        )
      ]);
      
      isFollowing = true;
      message = 'Vous suivez maintenant ce groupe';
      
      logger.info('Suivi effectué', { 
        userId, 
        groupId, 
        userUpdate: !!userUpdate,
        groupUpdate: !!groupUpdate,
        newFollowersCount: groupUpdate?.followersCount
      });
    }
    
    const finalGroup = await KpopGroup.findById(groupId).select('followersCount');
    const finalFollowersCount = finalGroup?.followersCount || 0;
    
    logger.info('Résultat final du suivi', { 
      userId, 
      groupId, 
      isFollowing,
      finalFollowersCount
    });
    
    return res.status(200).json({
      message,
      isFollowing,
      followersCount: finalFollowersCount
    });
    
  } catch (error) {
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
  const { groupId } = req.params;
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
  
  if (!mongoose.Types.ObjectId.isValid(groupId)) {
    return res.status(400).json({ 
      message: 'ID de groupe invalide',
      groupId,
      groupName: '',
      isFollowing: false,
      followersCount: 0
    } as any);
  }
  
  try {
    const [group, user] = await Promise.all([
      KpopGroup.findById(groupId).select('name followersCount'),
      User.findById(userId).select('followedGroups')
    ]);
    
    if (!group) {
      return res.status(404).json({ 
        message: 'Groupe non trouvé',
        groupId,
        groupName: '',
        isFollowing: false,
        followersCount: 0
      } as any);
    }
    
    if (!user) {
      return res.status(404).json({ 
        message: 'Utilisateur non trouvé',
        groupId,
        groupName: group.name,
        isFollowing: false,
        followersCount: group.followersCount || 0
      } as any);
    }
    
    const isFollowing = user.followedGroups?.some((id: mongoose.Types.ObjectId) => 
      id.toString() === groupId
    ) || false;
    
    return res.status(200).json({
      groupId,
      groupName: group.name,
      isFollowing,
      followersCount: group.followersCount || 0
    });
  } catch (error) {
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
    const user = await User.findById(userId)
      .populate({
        path: 'followedGroups',
        select: 'name profileImage genres followersCount',
        options: {
          sort: { name: 1 },
          skip: (page - 1) * limit,
          limit: limit
        }
      })
      .select('followedGroups followedGroupsCount');
    
    if (!user) {
      return res.status(404).json({ 
        message: 'Utilisateur non trouvé',
        groups: [],
        pagination: { page, limit, total: 0, pages: 0 }
      } as any);
    }
    
    return res.status(200).json({
      groups: user.followedGroups || [],
      pagination: {
        page,
        limit,
        total: user.followedGroupsCount || 0,
        pages: Math.ceil((user.followedGroupsCount || 0) / limit)
      }
    });
  } catch (error) {
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
  const { groupId } = req.params;
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;
  
  if (!mongoose.Types.ObjectId.isValid(groupId)) {
    return res.status(400).json({ message: 'ID de groupe invalide' });
  }
  
  try {
    const group = await KpopGroup.findById(groupId)
      .populate({
        path: 'followers',
        select: 'username email profileImage createdAt',
        options: {
          sort: { createdAt: -1 },
          skip: (page - 1) * limit,
          limit: limit
        }
      })
      .select('name followersCount followers');
    
    if (!group) {
      return res.status(404).json({ message: 'Groupe non trouvé' });
    }
    
    return res.status(200).json({
      groupId,
      groupName: group.name,
      followers: group.followers || [],
      pagination: {
        page,
        limit,
        total: group.followersCount || 0,
        pages: Math.ceil((group.followersCount || 0) / limit)
      }
    });
  } catch (error) {
    logger.error('Erreur lors de la récupération des followers', { 
      error: error instanceof Error ? error.message : 'Erreur inconnue',
      groupId
    });
    
    return res.status(500).json({ 
      message: 'Une erreur est survenue' 
    });
  }
});