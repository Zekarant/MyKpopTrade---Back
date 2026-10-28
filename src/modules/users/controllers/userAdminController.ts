import { Request, Response } from 'express';
import { badRequest } from '../../../commons/utils/httpError';
import { sendCsvFile, wantsCsv } from '../../../commons/utils/csv';
import { parsePagination } from '../../../commons/utils/pagination';
import { queryString } from '../../../commons/utils/query';
import { reactivateUser, suspendUser } from '../services/userSanctionService';
import {
  addUserNote as addNote,
  changeUserRole,
  deleteUserNote as deleteNote,
  getUserDetail as loadUserDetail,
  listUsers,
  UserListFilters
} from '../services/adminUserService';
import { buildUsersCsv } from '../services/adminExportService';
import { getDailyActivity, getUserCounts, TIMESERIES_DAYS } from '../services/adminStatsService';
import { getAdminQueue as loadAdminQueue } from '../services/adminQueueService';
import { searchAdminEverything } from '../services/adminSearchService';
import {
  anonymizeUserByIdentifier,
  cancelDeletionRequestByAdmin,
  confirmAccountDeletion,
  exportUserDataByIdentifier,
  getConsentCounts,
  listDeletionRequests
} from '../services/adminRgpdService';

const USER_LIST_DEFAULT_LIMIT = 20;
const SANCTION_STATUSES = ['active', 'suspended'];

/**
 * Liste tous les utilisateurs avec pagination et filtrage (admin) ; `format=csv` les exporte.
 * @route GET /api/users/admin/list
 */
export const getUsers = async (req: Request, res: Response) => {
  const filters: UserListFilters = {
    search: queryString(req.query.search),
    role: queryString(req.query.role),
    status: queryString(req.query.status)
  };

  if (wantsCsv(req.query.format)) {
    return sendCsvFile(res, await buildUsersCsv(filters));
  }

  const pageRequest = parsePagination(req.query, { defaultLimit: USER_LIST_DEFAULT_LIMIT });
  return res.status(200).json(await listUsers(filters, pageRequest));
};

/**
 * Statistiques des membres
 * @route GET /api/users/admin/stats
 */
export const getAdminStats = async (_req: Request, res: Response) => {
  return res.status(200).json(await getUserCounts());
};

/**
 * @route GET /api/users/admin/:userId/detail
 */
export const getUserDetail = async (req: Request, res: Response) => {
  return res.status(200).json(await loadUserDetail(String(req.params.userId)));
};

/**
 * @route POST /api/users/admin/:userId/notes
 */
export const addUserNote = async (req: Request, res: Response) => {
  const adminNotes = await addNote({
    adminId: req.user!.id,
    userId: String(req.params.userId),
    content: req.body.content
  });
  return res.status(201).json({ message: 'Note ajoutée', adminNotes });
};

/**
 * @route DELETE /api/users/admin/:userId/notes/:noteId
 */
export const deleteUserNote = async (req: Request, res: Response) => {
  const adminNotes = await deleteNote({
    adminId: req.user!.id,
    userId: String(req.params.userId),
    noteId: String(req.params.noteId)
  });
  return res.status(200).json({ message: 'Note supprimée', adminNotes });
};

/**
 * Recherche transverse (membres, annonces, publications)
 * @route GET /api/users/admin/search?q=
 */
export const adminGlobalSearch = async (req: Request, res: Response) => {
  const results = await searchAdminEverything(queryString(req.query.q) ?? '');
  return res.status(200).json({ results });
};

/**
 * File de travail admin
 * @route GET /api/users/admin/queue
 */
export const getAdminQueue = async (_req: Request, res: Response) => {
  return res.status(200).json(await loadAdminQueue());
};

/**
 * @route GET /api/users/admin/stats/timeseries
 */
export const getStatsTimeseries = async (_req: Request, res: Response) => {
  return res.status(200).json({ days: TIMESERIES_DAYS, series: await getDailyActivity() });
};

/**
 * Modifier le statut d'un utilisateur (suspendre/réactiver)
 * @route PUT /api/users/admin/:userId/status
 */
export const updateUserStatus = async (req: Request, res: Response) => {
  const { accountStatus, reason, durationDays } = req.body;
  if (!SANCTION_STATUSES.includes(accountStatus)) {
    throw badRequest('Statut invalide. Doit être "active" ou "suspended"');
  }

  const sanction = { adminId: req.user!.id, userId: String(req.params.userId), reason };
  const isSuspension = accountStatus === 'suspended';
  const user = isSuspension
    ? await suspendUser({ ...sanction, durationDays })
    : await reactivateUser(sanction);

  return res.status(200).json({
    message: `Utilisateur ${isSuspension ? 'suspendu' : 'réactivé'} avec succès`,
    user: {
      id: user._id,
      username: user.username,
      accountStatus: user.accountStatus,
      suspension: user.suspension
    }
  });
};

/**
 * Modifier le rôle d'un utilisateur
 * @route PUT /api/users/admin/:userId/role
 */
export const updateUserRole = async (req: Request, res: Response) => {
  const user = await changeUserRole({ adminId: req.user!.id, userId: String(req.params.userId), role: req.body.role });

  return res.status(200).json({
    message: `Rôle modifié en "${user.role}" avec succès`,
    user: {
      id: user._id,
      username: user.username,
      role: user.role
    }
  });
};

/**
 * RGPD: Obtenir les demandes de suppression en attente
 * @route GET /api/users/admin/deletion-requests
 */
export const getDeletionRequests = async (_req: Request, res: Response) => {
  return res.status(200).json({ users: await listDeletionRequests() });
};

/**
 * RGPD: Statistiques de consentement
 * @route GET /api/users/admin/rgpd-stats
 */
export const getRgpdStats = async (_req: Request, res: Response) => {
  return res.status(200).json(await getConsentCounts());
};

/**
 * RGPD: Export des données d'un utilisateur (Art. 15 - Droit d'accès)
 * @route GET /api/users/admin/export-data?search=
 */
export const adminExportUserData = async (req: Request, res: Response) => {
  return res.status(200).json(await exportUserDataByIdentifier(req.query.search));
};

/**
 * RGPD: Anonymiser un utilisateur (Art. 17 - Droit à l'effacement)
 * @route POST /api/users/admin/anonymize
 */
export const adminAnonymizeUser = async (req: Request, res: Response) => {
  await anonymizeUserByIdentifier({ adminId: req.user!.id, identifier: req.body.search });
  return res.status(200).json({ message: 'Utilisateur anonymisé avec succès' });
};

/**
 * RGPD: Confirmer la suppression d'un compte
 * @route POST /api/users/admin/:userId/confirm-deletion
 */
export const confirmDeletion = async (req: Request, res: Response) => {
  await confirmAccountDeletion({ adminId: req.user!.id, userId: String(req.params.userId) });
  return res.status(200).json({ message: 'Compte supprimé et anonymisé' });
};

/**
 * RGPD: Annuler une demande de suppression
 * @route POST /api/users/admin/:userId/cancel-deletion
 */
export const adminCancelDeletion = async (req: Request, res: Response) => {
  await cancelDeletionRequestByAdmin({ adminId: req.user!.id, userId: String(req.params.userId) });
  return res.status(200).json({ message: 'Demande de suppression annulée' });
};
