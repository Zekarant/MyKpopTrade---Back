import Follow from './model';
import mongoose from 'mongoose';
import User from '../../models/userModel';
import { NotificationService } from '../notifications/services/notificationService';

export class FollowService {
  /**
   * Follow a user
   */
  async follow(followerId: string, followingId: string): Promise<{ followed: boolean }> {
    if (followerId === followingId) {
      throw new Error('Vous ne pouvez pas vous suivre vous-même');
    }

    const existing = await Follow.findOne({ follower: followerId, following: followingId });
    if (existing) {
      throw new Error('Vous suivez déjà cet utilisateur');
    }

    await Follow.create({ follower: followerId, following: followingId });
    await this.notifyNewFollower(followerId, followingId);
    return { followed: true };
  }

  /**
   * Unfollow a user
   */
  async unfollow(followerId: string, followingId: string): Promise<{ unfollowed: boolean }> {
    const result = await Follow.deleteOne({ follower: followerId, following: followingId });
    if (result.deletedCount === 0) {
      throw new Error('Vous ne suivez pas cet utilisateur');
    }
    return { unfollowed: true };
  }

  /**
   * Remove a follower (someone who follows me)
   */
  async removeFollower(userId: string, followerId: string): Promise<{ removed: boolean }> {
    const result = await Follow.deleteOne({ follower: followerId, following: userId });
    if (result.deletedCount === 0) {
      throw new Error('Cet utilisateur ne vous suit pas');
    }
    return { removed: true };
  }

  /**
   * Toggle follow (follow if not following, unfollow if following)
   */
  async toggleFollow(followerId: string, followingId: string): Promise<{ isFollowing: boolean }> {
    if (followerId === followingId) {
      throw new Error('Vous ne pouvez pas vous suivre vous-même');
    }

    const existing = await Follow.findOne({ follower: followerId, following: followingId });
    if (existing) {
      await Follow.deleteOne({ _id: existing._id });
      return { isFollowing: false };
    }

    await Follow.create({ follower: followerId, following: followingId });
    await this.notifyNewFollower(followerId, followingId);
    return { isFollowing: true };
  }

  private async notifyNewFollower(followerId: string, followingId: string): Promise<void> {
    try {
      const follower = await User.findById(followerId).select('username').lean() as { username?: string } | null;
      await NotificationService.createNotification({
        recipientId: followingId,
        type: 'new_follower',
        title: 'Nouvel abonné',
        content: `${follower?.username || 'Un utilisateur'} vous suit désormais`,
        link: `/adherents/profile/${followerId}`,
        data: { followerId }
      });
    } catch {
      // notif failure must not break the follow action
    }
  }

  /**
   * Check if user A follows user B
   */
  async isFollowing(followerId: string, followingId: string): Promise<boolean> {
    const existing = await Follow.findOne({ follower: followerId, following: followingId });
    return !!existing;
  }

  /**
   * Get followers of a user (people who follow them)
   */
  async getFollowers(userId: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [followers, total] = await Promise.all([
      Follow.find({ following: userId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('follower', 'username profilePicture bio'),
      Follow.countDocuments({ following: userId })
    ]);

    return {
      followers: followers.map(f => f.follower),
      total,
      page,
      totalPages: Math.ceil(total / limit)
    };
  }

  /**
   * Get users that a user follows
   */
  async getFollowing(userId: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [following, total] = await Promise.all([
      Follow.find({ follower: userId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('following', 'username profilePicture bio'),
      Follow.countDocuments({ follower: userId })
    ]);

    return {
      following: following.map(f => f.following),
      total,
      page,
      totalPages: Math.ceil(total / limit)
    };
  }

  /**
   * Get follow counts for a user
   */
  async getCounts(userId: string) {
    const [followersCount, followingCount] = await Promise.all([
      Follow.countDocuments({ following: userId }),
      Follow.countDocuments({ follower: userId })
    ]);
    return { followersCount, followingCount };
  }

  /**
   * Get mutual follows (friends = both follow each other)
   */
  async getMutualFollows(userId: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const objectId = new mongoose.Types.ObjectId(userId);

    const result = await Follow.aggregate([
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
          data: [{ $skip: skip }, { $limit: limit }],
          count: [{ $count: 'total' }]
        }
      }
    ]);

    const mutualIds = result[0]?.data?.map((f: any) => f.following) || [];
    const total = result[0]?.count?.[0]?.total || 0;

    // Populate user info
    const User = mongoose.model('User');
    const friends = await User.find(
      { _id: { $in: mutualIds } },
      'username profilePicture bio'
    );

    return {
      friends,
      total,
      page,
      totalPages: Math.ceil(total / limit)
    };
  }
}

export default new FollowService();
