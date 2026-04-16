import mongoose from 'mongoose';
import KpopGroup from '../../../models/kpopGroupModel';
import User from '../../../models/userModel';
import { HttpError } from '../../../commons/utils/httpError';
import logger from '../../../commons/utils/logger';

function assertValidGroupId(groupId: string) {
  if (!mongoose.Types.ObjectId.isValid(groupId)) {
    throw new HttpError(400, 'ID de groupe invalide');
  }
}

export async function toggleFollow(userId: string, groupId: string) {
  assertValidGroupId(groupId);

  const [group, user] = await Promise.all([
    KpopGroup.findById(groupId),
    User.findById(userId)
  ]);

  if (!group) {
    throw new HttpError(404, 'Groupe non trouvé');
  }
  if (!user) {
    throw new HttpError(404, 'Utilisateur non trouvé');
  }

  const groupObjectId = new mongoose.Types.ObjectId(groupId);
  const userObjectId = new mongoose.Types.ObjectId(userId);

  const isCurrentlyFollowing = user.followedGroups?.some(
    (id: mongoose.Types.ObjectId) => id.equals(groupObjectId)
  ) || false;

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

  const isFollowing = !isCurrentlyFollowing;
  const message = isFollowing
    ? 'Vous suivez maintenant ce groupe'
    : 'Vous ne suivez plus ce groupe';

  logger.info('Résultat final du suivi', {
    userId,
    groupId,
    isFollowing,
    finalFollowersCount
  });

  return { message, isFollowing, followersCount: finalFollowersCount };
}

export async function getFollowStatusForUser(userId: string, groupId: string) {
  assertValidGroupId(groupId);

  const [group, user] = await Promise.all([
    KpopGroup.findById(groupId).select('name followersCount'),
    User.findById(userId).select('followedGroups')
  ]);

  if (!group) {
    throw new HttpError(404, 'Groupe non trouvé');
  }

  if (!user) {
    const err = new HttpError(404, 'Utilisateur non trouvé');
    (err as any).groupName = group.name;
    (err as any).followersCount = group.followersCount || 0;
    throw err;
  }

  const isFollowing = user.followedGroups?.some(
    (id: mongoose.Types.ObjectId) => id.toString() === groupId
  ) || false;

  return {
    groupId,
    groupName: group.name,
    isFollowing,
    followersCount: group.followersCount || 0
  };
}

export async function listFollowedGroups(userId: string, page: number, limit: number) {
  const user = await User.findById(userId)
    .populate({
      path: 'followedGroups',
      select: 'name profileImage genres followersCount',
      options: {
        sort: { name: 1 },
        skip: (page - 1) * limit,
        limit
      }
    })
    .select('followedGroups followedGroupsCount');

  if (!user) {
    throw new HttpError(404, 'Utilisateur non trouvé');
  }

  return {
    groups: user.followedGroups || [],
    pagination: {
      page,
      limit,
      total: user.followedGroupsCount || 0,
      pages: Math.ceil((user.followedGroupsCount || 0) / limit)
    }
  };
}

export async function listGroupFollowers(groupId: string, page: number, limit: number) {
  assertValidGroupId(groupId);

  const group = await KpopGroup.findById(groupId)
    .populate({
      path: 'followers',
      select: 'username email profileImage createdAt',
      options: {
        sort: { createdAt: -1 },
        skip: (page - 1) * limit,
        limit
      }
    })
    .select('name followersCount followers');

  if (!group) {
    throw new HttpError(404, 'Groupe non trouvé');
  }

  return {
    groupId,
    groupName: group.name,
    followers: group.followers || [],
    pagination: {
      page,
      limit,
      total: group.followersCount || 0,
      pages: Math.ceil((group.followersCount || 0) / limit)
    }
  };
}
