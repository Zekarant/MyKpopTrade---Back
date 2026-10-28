import { Request, Response } from 'express';
import {
  createGroup,
  listGroups,
  searchGroupsByQuery,
  fetchPopularGroups,
  fetchGroupWithStats,
  updateGroup,
  deleteGroup
} from '../services/kpopGroupsService';
import { clampLimit, parsePagination, MAX_PAGE_SIZE } from '../../../commons/utils/pagination';
import { queryString } from '../../../commons/utils/query';

const DEFAULT_LIMIT = 20;
/** Le panneau admin K-pop charge jusqu'à 2000 groupes d'un coup. */
const CATALOG_MAX_LIMIT = 2000;

/**
 * Créer un nouveau groupe K-pop (Admin uniquement)
 */
export const createKpopGroup = async (req: Request, res: Response) => {
  const group = await createGroup(req.body ?? {});

  res.status(201).json({
    message: 'Groupe K-pop créé avec succès',
    group
  });
};

/**
 * Récupérer tous les groupes K-pop avec pagination et filtres
 */
export const getKpopGroups = async (req: Request, res: Response) => {
  const { page, limit } = parsePagination(req.query, { defaultLimit: DEFAULT_LIMIT, maxLimit: CATALOG_MAX_LIMIT });

  const result = await listGroups({
    page,
    limit,
    sortBy: queryString(req.query.sortBy) || 'name',
    sortOrder: req.query.sortOrder === 'desc' ? -1 : 1,
    genre: queryString(req.query.genre),
    tag: queryString(req.query.tag),
    search: queryString(req.query.search)
  });
  res.status(200).json(result);
};

/**
 * Rechercher des groupes K-pop avec des filtres avancés
 */
export const searchGroups = async (req: Request, res: Response) => {
  const result = await searchGroupsByQuery({
    query: queryString(req.query.query),
    limit: clampLimit(req.query.limit, DEFAULT_LIMIT, MAX_PAGE_SIZE),
    includeInactive: req.query.includeInactive === 'true'
  });
  res.status(200).json(result);
};

/**
 * Récupérer les groupes K-pop les plus populaires
 */
export const getPopularGroups = async (req: Request, res: Response) => {
  const groups = await fetchPopularGroups(clampLimit(req.query.limit, DEFAULT_LIMIT, MAX_PAGE_SIZE));
  res.status(200).json({
    groups,
    total: groups.length
  });
};

/**
 * Récupérer un groupe K-pop par son ID avec ses albums et statistiques
 */
export const getKpopGroupById = async (req: Request, res: Response) => {
  const result = await fetchGroupWithStats(req.params.groupId as string);
  res.status(200).json(result);
};

/**
 * Mettre à jour un groupe K-pop (Admin uniquement)
 */
export const updateKpopGroup = async (req: Request, res: Response) => {
  const group = await updateGroup(req.params.groupId as string, req.body ?? {});
  res.status(200).json({
    message: 'Groupe mis à jour avec succès',
    group
  });
};

/**
 * Supprimer un groupe (Admin uniquement)
 */
export const deleteKpopGroup = async (req: Request, res: Response) => {
  const albumsDeleted = await deleteGroup(req.params.groupId as string);
  res.status(200).json({
    message: 'Groupe supprimé avec succès',
    albumsDeleted
  });
};
