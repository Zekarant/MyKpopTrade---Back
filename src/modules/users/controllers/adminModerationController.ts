import { Request, Response } from 'express';
import mongoose from 'mongoose';
import Post, { IPost } from '../../posts/model';
import AuditLog, { IAuditLog } from '../../../models/auditLogModel';
import { IUser } from '../../../models/userModel';
import { asyncHandler } from '../../../commons/middlewares/errorMiddleware';
import { dispatchAdminAlert } from '../../../commons/services/adminAlertService';
import { escapeRegex } from '../../../commons/utils/escapeRegex';
import { clampLimit, MAX_PAGE_SIZE } from '../../../commons/utils/pagination';
import { queryInt, queryString } from '../../../commons/utils/query';

/**
 * Lister tous les posts (admin) avec filtres
 */
export const getAdminPosts = asyncHandler(async (req: Request, res: Response) => {
  const page = queryInt(req.query.page) || 1;
  const limit = clampLimit(req.query.limit, 20, MAX_PAGE_SIZE);
  const search = queryString(req.query.search);
  const type = queryString(req.query.type); // 'post' | 'reply' | 'all'

  const filter: mongoose.QueryFilter<IPost> = {};

  if (type === 'post') filter.isReply = false;
  else if (type === 'reply') filter.isReply = true;

  if (search) {
    filter.content = { $regex: escapeRegex(String(search)), $options: 'i' };
  }

  const [posts, count] = await Promise.all([
    Post.find(filter)
      .populate('author', 'username profilePicture isIdentityVerified')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Post.countDocuments(filter)
  ]);

  return res.status(200).json({
    posts,
    pagination: { page, limit, totalItems: count, totalPages: Math.ceil(count / limit) }
  });
});

/**
 * Stats des posts (admin)
 */
export const getPostStats = asyncHandler(async (req: Request, res: Response) => {
  const [totalPosts, totalReplies, todayPosts] = await Promise.all([
    Post.countDocuments({ isReply: false }),
    Post.countDocuments({ isReply: true }),
    Post.countDocuments({
      isReply: false,
      createdAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) }
    })
  ]);

  return res.status(200).json({
    totalPosts,
    totalReplies,
    todayPosts
  });
});

/**
 * Supprimer un post (modération admin)
 */
export const adminDeletePost = asyncHandler(async (req: Request, res: Response) => {
  const adminId = req.user!.id;
  const { postId } = req.params;
  const { reason } = req.body;

  const post = await Post.findById(postId).populate<{ author: Pick<IUser, 'username'> | null }>('author', 'username');
  if (!post) {
    return res.status(404).json({ message: 'Post introuvable' });
  }

  // Si c'est un post parent, supprimer aussi les réponses
  if (!post.isReply) {
    await Post.deleteMany({ parentPost: postId });
  } else {
    // Décrémenter le compteur de réponses du parent
    await Post.findByIdAndUpdate(post.parentPost, { $inc: { repliesCount: -1 } });
  }

  await Post.findByIdAndDelete(postId);

  // Log d'audit
  await AuditLog.create({
    admin: adminId,
    action: 'delete_post',
    targetType: 'post',
    targetId: post._id,
    details: reason || 'Suppression par modération',
    metadata: {
      authorUsername: post.author?.username,
      contentPreview: post.content.substring(0, 100)
    }
  });

  dispatchAdminAlert({
    event: 'post.deleted',
    severity: 'info',
    title: `${post.isReply ? 'Réponse' : 'Post'} supprimé par un administrateur`,
    summary: reason || 'Suppression par modération',
    adminTab: 'moderation',
    fields: [
      { name: 'Auteur', value: post.author?.username || 'inconnu', inline: true },
      { name: 'Contenu', value: post.content.substring(0, 200) }
    ],
    data: { postId, isReply: post.isReply }
  });

  return res.status(200).json({ message: 'Post supprimé' });
});

/**
 * Récupérer les logs d'audit
 */
export const getAuditLogs = asyncHandler(async (req: Request, res: Response) => {
  const page = queryInt(req.query.page) || 1;
  const limit = clampLimit(req.query.limit, 30, MAX_PAGE_SIZE);
  const targetType = queryString(req.query.targetType);

  const filter: mongoose.QueryFilter<IAuditLog> = {};
  if (targetType && ['user', 'product', 'post', 'report', 'verification', 'system', 'dispute', 'payment'].includes(targetType)) {
    filter.targetType = targetType as IAuditLog['targetType'];
  }

  const [logs, count] = await Promise.all([
    AuditLog.find(filter)
      .populate('admin', 'username profilePicture')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    AuditLog.countDocuments(filter)
  ]);

  return res.status(200).json({
    logs,
    pagination: { page, limit, totalItems: count, totalPages: Math.ceil(count / limit) }
  });
});

/**
 * Stats d'audit
 */
export const getAuditStats = asyncHandler(async (req: Request, res: Response) => {
  const today = new Date(new Date().setHours(0, 0, 0, 0));
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [todayActions, weekActions, byType] = await Promise.all([
    AuditLog.countDocuments({ createdAt: { $gte: today } }),
    AuditLog.countDocuments({ createdAt: { $gte: weekAgo } }),
    AuditLog.aggregate<{ _id: string; count: number }>([
      { $match: { createdAt: { $gte: weekAgo } } },
      { $group: { _id: '$targetType', count: { $sum: 1 } } }
    ])
  ]);

  return res.status(200).json({
    todayActions,
    weekActions,
    byType: byType.reduce((acc: Record<string, number>, item) => { acc[item._id] = item.count; return acc; }, {})
  });
});
