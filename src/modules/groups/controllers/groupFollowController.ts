import { Request, Response } from 'express';
import {
  toggleFollow,
  getFollowStatusForUser,
  listFollowedGroups,
  listGroupFollowers
} from '../services/groupFollowService';
import { parsePagination } from '../../../commons/utils/pagination';

/**
 * Suivre ou arrêter de suivre un groupe
 */
export const toggleFollowGroup = async (req: Request, res: Response) => {
  const result = await toggleFollow(req.user!.id, req.params.groupId as string);
  res.status(200).json(result);
};

/**
 * Vérifier si l'utilisateur suit un groupe
 */
export const getFollowStatus = async (req: Request, res: Response) => {
  const result = await getFollowStatusForUser(req.user!.id, req.params.groupId as string);
  res.status(200).json(result);
};

/**
 * Récupérer les groupes suivis par l'utilisateur
 */
export const getUserFollowedGroups = async (req: Request, res: Response) => {
  const { page, limit } = parsePagination(req.query);
  const result = await listFollowedGroups(req.user!.id, page, limit);
  res.status(200).json(result);
};

/**
 * Récupérer les followers d'un groupe
 */
export const getGroupFollowers = async (req: Request, res: Response) => {
  const { page, limit } = parsePagination(req.query);
  const result = await listGroupFollowers(req.params.groupId as string, page, limit);
  res.status(200).json(result);
};
