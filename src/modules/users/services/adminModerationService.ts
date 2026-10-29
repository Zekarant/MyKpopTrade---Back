import mongoose from 'mongoose';
import Post, { IPost } from '../../../models/postModel';
import AuditLog, { IAuditLog } from '../../../models/auditLogModel';
import { IUser } from '../../../models/userModel';
import { recordAuditLog } from '../../../commons/utils/auditService';
import { dispatchAdminAlert } from '../../../commons/services/adminAlertService';
import { escapeRegex } from '../../../commons/utils/escapeRegex';
import { postNotFound } from '../../posts/services/postService';
import { PageRequest, paginationMeta } from '../../../commons/utils/pagination';
import { USER_CARD_FIELDS, VERIFIED_USER_CARD_FIELDS } from '../../../commons/utils/userFields';

const AUDIT_TARGET_TYPES: IAuditLog['targetType'][] = [
  'user', 'product', 'post', 'report', 'verification', 'system', 'dispute', 'payment'
];
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const AUDIT_WEEK_DAYS = 7;
const DEFAULT_DELETION_REASON = 'Suppression par modération';
const AUDIT_PREVIEW_LENGTH = 100;
const ALERT_PREVIEW_LENGTH = 200;

const startOfToday = (now: Date) => new Date(new Date(now).setHours(0, 0, 0, 0));

export interface AdminPostFilters {
  search?: string;
  /** 'post' (publications), 'reply' (réponses) ; toute autre valeur : les deux. */
  type?: string;
}

export async function listAdminPosts({ search, type }: AdminPostFilters, pageRequest: PageRequest) {
  const filter: mongoose.QueryFilter<IPost> = {};
  if (type === 'post') filter.isReply = false;
  else if (type === 'reply') filter.isReply = true;
  if (search) {
    filter.content = { $regex: escapeRegex(search), $options: 'i' };
  }

  const [posts, total] = await Promise.all([
    Post.find(filter)
      .populate('author', VERIFIED_USER_CARD_FIELDS)
      .sort({ createdAt: -1 })
      .skip(pageRequest.skip)
      .limit(pageRequest.limit)
      .lean(),
    Post.countDocuments(filter)
  ]);

  return { posts, pagination: paginationMeta(pageRequest, total) };
}

export async function getPostCounts(now: Date = new Date()) {
  const [totalPosts, totalReplies, todayPosts] = await Promise.all([
    Post.countDocuments({ isReply: false }),
    Post.countDocuments({ isReply: true }),
    Post.countDocuments({ isReply: false, createdAt: { $gte: startOfToday(now) } })
  ]);

  return { totalPosts, totalReplies, todayPosts };
}

/** Supprime un post et ses réponses (ou une réponse, en tenant à jour le compteur du parent). */
export async function deletePostAsAdmin({ adminId, postId, reason }: { adminId: string; postId: string; reason?: unknown }) {
  const post = await Post.findById(postId)
    .populate<{ author: Pick<IUser, 'username'> | null }>('author', 'username')
    .lean();
  if (!post) {
    throw postNotFound();
  }

  if (!post.isReply) {
    await Post.deleteMany({ parentPost: postId });
  } else {
    await Post.findByIdAndUpdate(post.parentPost, { $inc: { repliesCount: -1 } });
  }
  await Post.findByIdAndDelete(postId);

  const motive = typeof reason === 'string' && reason ? reason : DEFAULT_DELETION_REASON;

  await recordAuditLog({
    adminId,
    action: 'delete_post',
    targetType: 'post',
    targetId: post._id,
    details: motive,
    metadata: {
      authorUsername: post.author?.username,
      contentPreview: post.content.substring(0, AUDIT_PREVIEW_LENGTH)
    }
  });

  dispatchAdminAlert({
    event: 'post.deleted',
    severity: 'info',
    title: `${post.isReply ? 'Réponse' : 'Post'} supprimé par un administrateur`,
    summary: motive,
    adminTab: 'moderation',
    fields: [
      { name: 'Auteur', value: post.author?.username || 'inconnu', inline: true },
      { name: 'Contenu', value: post.content.substring(0, ALERT_PREVIEW_LENGTH) }
    ],
    data: { postId, isReply: post.isReply }
  });
}

export async function listAuditLogs(targetType: string | undefined, pageRequest: PageRequest) {
  const filter: mongoose.QueryFilter<IAuditLog> = {};
  if (targetType && (AUDIT_TARGET_TYPES as string[]).includes(targetType)) {
    filter.targetType = targetType as IAuditLog['targetType'];
  }

  const [logs, total] = await Promise.all([
    AuditLog.find(filter)
      .populate('admin', USER_CARD_FIELDS)
      .sort({ createdAt: -1 })
      .skip(pageRequest.skip)
      .limit(pageRequest.limit)
      .lean(),
    AuditLog.countDocuments(filter)
  ]);

  return { logs, pagination: paginationMeta(pageRequest, total) };
}

export async function getAuditCounts(now: Date = new Date()) {
  const weekAgo = new Date(now.getTime() - AUDIT_WEEK_DAYS * MS_PER_DAY);

  const [todayActions, weekActions, byType] = await Promise.all([
    AuditLog.countDocuments({ createdAt: { $gte: startOfToday(now) } }),
    AuditLog.countDocuments({ createdAt: { $gte: weekAgo } }),
    AuditLog.aggregate<{ _id: string; count: number }>([
      { $match: { createdAt: { $gte: weekAgo } } },
      { $group: { _id: '$targetType', count: { $sum: 1 } } }
    ])
  ]);

  return {
    todayActions,
    weekActions,
    byType: byType.reduce((acc: Record<string, number>, item) => {
      acc[item._id] = item.count;
      return acc;
    }, {})
  };
}
