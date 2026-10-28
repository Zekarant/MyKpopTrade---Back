import mongoose from 'mongoose';
import Follow from '../../../models/followModel';
import User from '../../../models/userModel';
import { createNotification } from '../../notifications/services/notificationService';
import { assertNotBlocked } from '../../users/services/userBlockService';
import { badRequest, notFound } from '../../../commons/utils/httpError';
import { PageRequest, paginationMeta } from '../../../commons/utils/pagination';
import logger from '../../../commons/utils/logger';

/** Code MongoDB d'une violation d'index unique. */
const DUPLICATE_KEY_ERROR = 11000;
const PUBLIC_USER_FIELDS = 'username profilePicture bio';

/** Un compte supprimé définitivement laisse un `null` après populate. */
const existingUsers = <T>(users: (T | null)[]): T[] => users.filter((user): user is T => user !== null);

async function notifyNewFollower(followerId: string, followingId: string): Promise<void> {
  try {
    const follower = await User.findById(followerId).select('username').lean<{ username?: string } | null>();
    await createNotification({
      recipientId: followingId,
      type: 'new_follower',
      title: 'Nouvel abonné',
      content: `${follower?.username || 'Un utilisateur'} vous suit désormais`,
      link: `/adherents/profile/${followerId}`,
      data: { followerId }
    });
  } catch (error) {
    // Une notification manquée ne doit pas annuler l'abonnement.
    logger.warn('Notification de nouvel abonné impossible', {
      followerId,
      followingId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

/**
 * Retire un abonné (quelqu'un qui me suit).
 *
 * @throws HttpError 404 si cet utilisateur ne me suit pas.
 */
export async function removeFollower(userId: string, followerId: string): Promise<{ removed: boolean }> {
  const result = await Follow.deleteOne({ follower: followerId, following: userId });
  if (result.deletedCount === 0) {
    throw notFound('Cet utilisateur ne vous suit pas');
  }
  return { removed: true };
}

/**
 * S'abonne si l'abonnement n'existe pas, se désabonne sinon.
 *
 * @throws HttpError 400 pour soi-même, 404 si la cible n'existe pas,
 *   403 BLOCKED si l'un des deux a bloqué l'autre (à l'abonnement seulement).
 */
export async function toggleFollow(followerId: string, followingId: string): Promise<{ isFollowing: boolean }> {
  if (followerId === followingId) {
    throw badRequest('Vous ne pouvez pas vous suivre vous-même');
  }

  const existing = await Follow.findOne({ follower: followerId, following: followingId }).select('_id').lean();
  if (existing) {
    await Follow.deleteOne({ _id: existing._id });
    return { isFollowing: false };
  }

  const target = await User.findById(followingId).select('accountStatus').lean<{ accountStatus?: string } | null>();
  if (!target || target.accountStatus === 'deleted') {
    throw notFound('Utilisateur introuvable');
  }
  // Se désabonner reste possible ; s'abonner est refusé entre membres bloqués.
  await assertNotBlocked(followerId, followingId);

  try {
    await Follow.create({ follower: followerId, following: followingId });
  } catch (error) {
    // Double clic simultané : l'index unique a refusé le second abonnement.
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === DUPLICATE_KEY_ERROR) {
      return { isFollowing: true };
    }
    throw error;
  }
  await notifyNewFollower(followerId, followingId);
  return { isFollowing: true };
}

/** L'utilisateur A suit-il l'utilisateur B ? */
export async function isFollowing(followerId: string, followingId: string): Promise<boolean> {
  return Boolean(await Follow.exists({ follower: followerId, following: followingId }));
}

/** Identifiants des membres que l'utilisateur suit. */
export async function listFollowedUserIds(userId: string): Promise<mongoose.Types.ObjectId[]> {
  const follows = await Follow.find({ follower: userId }).select('following').lean();
  return follows.map((follow) => follow.following);
}

/** Abonnés d'un utilisateur (les membres qui le suivent). */
export async function getFollowers(userId: string, pageRequest: PageRequest) {
  const [follows, total] = await Promise.all([
    Follow.find({ following: userId })
      .sort({ createdAt: -1 })
      .skip(pageRequest.skip)
      .limit(pageRequest.limit)
      .populate('follower', PUBLIC_USER_FIELDS)
      .lean(),
    Follow.countDocuments({ following: userId })
  ]);

  return {
    followers: existingUsers(follows.map((follow) => follow.follower)),
    pagination: paginationMeta(pageRequest, total)
  };
}

/** Abonnements d'un utilisateur (les membres qu'il suit). */
export async function getFollowing(userId: string, pageRequest: PageRequest) {
  const [follows, total] = await Promise.all([
    Follow.find({ follower: userId })
      .sort({ createdAt: -1 })
      .skip(pageRequest.skip)
      .limit(pageRequest.limit)
      .populate('following', PUBLIC_USER_FIELDS)
      .lean(),
    Follow.countDocuments({ follower: userId })
  ]);

  return {
    following: existingUsers(follows.map((follow) => follow.following)),
    pagination: paginationMeta(pageRequest, total)
  };
}

export async function getCounts(userId: string) {
  const [followersCount, followingCount] = await Promise.all([
    Follow.countDocuments({ following: userId }),
    Follow.countDocuments({ follower: userId })
  ]);
  return { followersCount, followingCount };
}

/** Amis : les membres que l'utilisateur suit et qui le suivent en retour. */
export async function getMutualFollows(userId: string, pageRequest: PageRequest) {
  const objectId = new mongoose.Types.ObjectId(userId);

  const result = await Follow.aggregate<{
    data: Array<{ following: mongoose.Types.ObjectId }>;
    count: Array<{ total: number }>;
  }>([
    { $match: { follower: objectId } },
    {
      $lookup: {
        from: 'follows',
        let: { followingId: '$following' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$follower', '$$followingId'] },
                  { $eq: ['$following', objectId] }
                ]
              }
            }
          }
        ],
        as: 'mutual'
      }
    },
    { $match: { 'mutual.0': { $exists: true } } },
    { $sort: { createdAt: -1 } },
    {
      $facet: {
        data: [{ $skip: pageRequest.skip }, { $limit: pageRequest.limit }],
        count: [{ $count: 'total' }]
      }
    }
  ]);

  const mutualIds = result[0]?.data?.map((follow) => follow.following) || [];
  const total = result[0]?.count?.[0]?.total || 0;

  const friends = await User.find({ _id: { $in: mutualIds } }, PUBLIC_USER_FIELDS).lean();

  return {
    friends,
    pagination: paginationMeta(pageRequest, total)
  };
}
