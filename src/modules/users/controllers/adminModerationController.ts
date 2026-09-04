import { Request, Response } from 'express';
import Post from '../../posts/model';
import AuditLog from '../../../models/auditLogModel';
import { asyncHandler } from '../../../commons/middlewares/errorMiddleware';
import { dispatchAdminAlert } from '../../../commons/services/adminAlertService';

/**
 * Lister tous les posts (admin) avec filtres
 */
export const getAdminPosts = asyncHandler(async (req: Request, res: Response) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;
  const search = req.query.search as string;
  const type = req.query.type as string; // 'post' | 'reply' | 'all'

  const filter: any = {};

  if (type === 'post') filter.isReply = false;
  else if (type === 'reply') filter.isReply = true;

  if (search) {
    filter.content = { $regex: search, $options: 'i' };
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
  const adminId = (req as any).user.id;
  const { postId } = req.params;
  const { reason } = req.body;

  const post = await Post.findById(postId).populate('author', 'username');
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
    targetId: postId,
    details: reason || 'Suppression par modération',
    metadata: {
      authorUsername: (post.author as any)?.username,
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
      { name: 'Auteur', value: (post.author as any)?.username || 'inconnu', inline: true },
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
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 30;
  const targetType = req.query.targetType as string;

  const filter: any = {};
  if (targetType && ['user', 'product', 'post', 'report', 'verification', 'system', 'dispute', 'payment'].includes(targetType)) {
    filter.targetType = targetType;
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
    AuditLog.aggregate([
      { $match: { createdAt: { $gte: weekAgo } } },
      { $group: { _id: '$targetType', count: { $sum: 1 } } }
    ])
  ]);

  return res.status(200).json({
    todayActions,
    weekActions,
    byType: byType.reduce((acc: any, item: any) => { acc[item._id] = item.count; return acc; }, {})
  });
});
