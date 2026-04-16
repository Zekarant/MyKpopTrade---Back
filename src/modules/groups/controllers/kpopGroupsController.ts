import { Request, Response } from 'express';
import { asyncHandler } from '../../../commons/middlewares/errorMiddleware';
import logger from '../../../commons/utils/logger';
import { mapHttpError } from '../../../commons/utils/httpErrorMapper';
import {
  createGroup,
  listGroups,
  searchGroupsByQuery,
  fetchPopularGroups,
  fetchGroupWithStats,
  updateGroup,
  deleteGroup
} from '../services/kpopGroupsService';

/**
 * Créer un nouveau groupe K-pop (Admin uniquement)
 */
export const createKpopGroup = asyncHandler(async (req: Request, res: Response) => {
  const groupData = req.body;

  try {
    const group = await createGroup(groupData);

    return res.status(201).json({
      message: 'Groupe K-pop créé avec succès',
      group
    });
  } catch (error) {
    const mapped = mapHttpError(res, error);
    if (mapped) return mapped;

    logger.error('Erreur lors de la création du groupe K-pop', {
      error: error instanceof Error ? error.message : 'Erreur inconnue',
      groupData: groupData.name
    });

    return res.status(500).json({
      message: 'Une erreur est survenue lors de la création du groupe'
    });
  }
});

/**
 * Récupérer tous les groupes K-pop avec pagination et filtres
 */
export const getKpopGroups = asyncHandler(async (req: Request, res: Response) => {
  try {
    const result = await listGroups(req.query);
    return res.status(200).json(result);
  } catch (error) {
    logger.error('Erreur lors de la récupération des groupes', {
      error: error instanceof Error ? error.message : 'Erreur inconnue'
    });
    return res.status(500).json({
      message: 'Une erreur est survenue lors de la récupération des groupes'
    });
  }
});

/**
 * Rerchercher des groupes K-pop avec des filtres avancés
 */
export const searchGroups = asyncHandler(async (req: Request, res: Response) => {
  const { query } = req.query;
  const limit = parseInt((req.query.limit as string) || '20');
  const includeInactive = req.query.includeInactive === 'true';

  try {
    const result = await searchGroupsByQuery({ query, limit, includeInactive });
    return res.status(200).json(result);
  } catch (error) {
    const mapped = mapHttpError(res, error);
    if (mapped) return mapped;

    logger.error('Erreur lors de la recherche de groupes', {
      error: error instanceof Error ? error.message : 'Erreur inconnue',
      query
    });

    return res.status(500).json({
      message: 'Une erreur est survenue lors de la recherche'
    });
  }
});

/**
 * Récupérer les groupes K-pop les plus populaires
 */
export const getPopularGroups = asyncHandler(async (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string) || 20;

  try {
    const groups = await fetchPopularGroups(limit);
    return res.status(200).json({
      groups,
      total: groups.length
    });
  } catch (error) {
    logger.error('Erreur lors de la récupération des groupes populaires', {
      error: error instanceof Error ? error.message : 'Erreur inconnue'
    });
    return res.status(500).json({
      message: 'Une erreur est survenue'
    });
  }
});

/**
 * Récupérer un groupe K-pop par son ID avec ses albums et statistiques
 */
export const getKpopGroupById = asyncHandler(async (req: Request, res: Response) => {
  const groupId = req.params.groupId as string;

  try {
    const result = await fetchGroupWithStats(groupId);
    return res.status(200).json(result);
  } catch (error) {
    const mapped = mapHttpError(res, error);
    if (mapped) return mapped;

    logger.error('Erreur lors de la récupération du groupe', {
      error: error instanceof Error ? error.message : 'Erreur inconnue',
      groupId
    });

    return res.status(500).json({
      message: 'Une erreur est survenue lors de la récupération du groupe'
    });
  }
});

/**
 * Mettre à jour un groupe K-pop (Admin uniquement)
 */
export const updateKpopGroup = asyncHandler(async (req: Request, res: Response) => {
  const groupId = req.params.groupId as string;

  try {
    const group = await updateGroup(groupId, req.body);
    return res.status(200).json({
      message: 'Groupe mis à jour avec succès',
      group
    });
  } catch (error) {
    const mapped = mapHttpError(res, error);
    if (mapped) return mapped;

    logger.error('Erreur lors de la mise à jour du groupe', {
      error: error instanceof Error ? error.message : 'Erreur inconnue',
      groupId
    });

    return res.status(500).json({
      message: 'Une erreur est survenue lors de la mise à jour du groupe'
    });
  }
});

/**
 * Supprimer un groupe (Admin uniquement)
 */
export const deleteKpopGroup = asyncHandler(async (req: Request, res: Response) => {
  const groupId = req.params.groupId as string;

  try {
    const albumsDeleted = await deleteGroup(groupId);
    return res.status(200).json({
      message: 'Groupe supprimé avec succès',
      albumsDeleted
    });
  } catch (error) {
    const mapped = mapHttpError(res, error);
    if (mapped) return mapped;

    logger.error('Erreur lors de la suppression du groupe', {
      error: error instanceof Error ? error.message : 'Erreur inconnue',
      groupId
    });

    return res.status(500).json({
      message: 'Une erreur est survenue lors de la suppression du groupe'
    });
  }
});
