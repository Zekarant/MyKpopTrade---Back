import { Request, Response } from 'express';
import { parsePagination } from '../../../commons/utils/pagination';
import { queryString } from '../../../commons/utils/query';
import {
  deletePostAsAdmin,
  getAuditCounts,
  getPostCounts,
  listAdminPosts,
  listAuditLogs
} from '../services/adminModerationService';

const POSTS_DEFAULT_LIMIT = 20;
const AUDIT_DEFAULT_LIMIT = 30;

/**
 * Lister tous les posts (admin) avec filtres
 * @route GET /api/users/admin/posts?search=&type=post|reply|all
 */
export const getAdminPosts = async (req: Request, res: Response) => {
  const filters = { search: queryString(req.query.search), type: queryString(req.query.type) };
  const pageRequest = parsePagination(req.query, { defaultLimit: POSTS_DEFAULT_LIMIT });
  return res.status(200).json(await listAdminPosts(filters, pageRequest));
};

/**
 * Stats des posts (admin)
 * @route GET /api/users/admin/posts/stats
 */
export const getPostStats = async (_req: Request, res: Response) => {
  return res.status(200).json(await getPostCounts());
};

/**
 * Supprimer un post (modération admin)
 * @route DELETE /api/users/admin/posts/:postId
 */
export const adminDeletePost = async (req: Request, res: Response) => {
  await deletePostAsAdmin({ adminId: req.user!.id, postId: String(req.params.postId), reason: req.body?.reason });
  return res.status(200).json({ message: 'Post supprimé' });
};

/**
 * Récupérer les logs d'audit
 * @route GET /api/users/admin/audit?targetType=
 */
export const getAuditLogs = async (req: Request, res: Response) => {
  const pageRequest = parsePagination(req.query, { defaultLimit: AUDIT_DEFAULT_LIMIT });
  return res.status(200).json(await listAuditLogs(queryString(req.query.targetType), pageRequest));
};

/**
 * Stats d'audit
 * @route GET /api/users/admin/audit/stats
 */
export const getAuditStats = async (_req: Request, res: Response) => {
  return res.status(200).json(await getAuditCounts());
};
