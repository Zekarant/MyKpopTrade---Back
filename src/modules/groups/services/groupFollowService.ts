import mongoose from 'mongoose';
import KpopGroup, { IKpopGroup } from '../../../models/kpopGroupModel';
import User from '../../../models/userModel';
import { HttpError, userNotFound } from '../../../commons/utils/httpError';
import { paginationMeta } from '../../../commons/utils/pagination';
import logger from '../../../commons/utils/logger';

export type FollowedGroupSummary = Pick<IKpopGroup, 'name' | 'profileImage' | 'genres' | 'followersCount'>;

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
    throw userNotFound();
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
        { returnDocument: 'after' }
      ),
      KpopGroup.findByIdAndUpdate(
        groupId,
        {
          $pull: { followers: userObjectId },
          $inc: { followersCount: -1 }
        },
        { returnDocument: 'after' }
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
        { returnDocument: 'after' }
      ),
      KpopGroup.findByIdAndUpdate(
        groupId,
        {
          $addToSet: { followers: userObjectId },
          $inc: { followersCount: 1 }
        },
        { returnDocument: 'after' }
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
    // Le corps d'erreur garde le nom et le compteur du groupe, comme avant.
    throw new HttpError(404, 'Utilisateur non trouvé', 'USER_NOT_FOUND', {
      groupId,
      groupName: group.name,
      isFollowing: false,
      followersCount: group.followersCount || 0
    });
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
    .populate<{ followedGroups?: FollowedGroupSummary[] }>({
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
    throw userNotFound();
  }

  return {
    groups: user.followedGroups || [],
    pagination: paginationMeta({ page, limit }, user.followedGroupsCount || 0)
  };
}

export async function listGroupFollowers(groupId: string, page: number, limit: number) {
  assertValidGroupId(groupId);

  const group = await KpopGroup.findById(groupId)
    .populate({
      path: 'followers',
      // Route publique : pas d'email.
      select: 'username profilePicture createdAt',
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
    pagination: paginationMeta({ page, limit }, group.followersCount || 0)
  };
}
