import { Request, Response } from 'express';
import { sendCsvFile, wantsCsv } from '../../../commons/utils/csv';
import { parsePagination } from '../../../commons/utils/pagination';
import { queryString } from '../../../commons/utils/query';
import {
  assertValidTarget,
  buildReportsCsv,
  bulkUpdateReportStatus as bulkUpdateStatus,
  createReport as fileReport,
  findReportByReporter,
  getReportDetail as loadReportDetail,
  listReports,
  listReportsByReporter,
  ReportListFilters,
  updateReportStatus as updateStatus
} from '../services/reportService';

const MY_REPORTS_PAGE = { defaultLimit: 10, maxLimit: 50 };
const ALL_REPORTS_PAGE = { defaultLimit: 20, maxLimit: 100 };

/**
 * Créer un nouveau signalement
 * @route POST /api/reports
 */
export const createReport = async (req: Request, res: Response) => {
  const { targetType, targetId, reason, details } = req.body ?? {};
  const report = await fileReport(req.user!.id, { targetType, targetId, reason, details });

  return res.status(201).json({
    message: 'Signalement créé avec succès',
    report: {
      id: report._id,
      reason: report.reason,
      status: report.status,
      createdAt: report.createdAt
    }
  });
};

/**
 * Récupérer ses propres signalements
 * @route GET /api/reports/me
 */
export const getUserReports = async (req: Request, res: Response) => {
  const pageRequest = parsePagination(req.query, MY_REPORTS_PAGE);
  return res.status(200).json(await listReportsByReporter(req.user!.id, queryString(req.query.status), pageRequest));
};

/**
 * Vérifier si l'utilisateur a déjà signalé un élément
 * @route GET /api/reports/check/:targetType/:targetId
 */
export const checkUserReport = async (req: Request, res: Response) => {
  const { targetType, targetId } = req.params;
  assertValidTarget(targetType, targetId);

  const existingReport = await findReportByReporter(req.user!.id, targetType, String(targetId));

  return res.status(200).json({
    hasReported: !!existingReport,
    report: existingReport ? {
      id: existingReport._id,
      status: existingReport.status,
      reason: existingReport.reason,
      createdAt: existingReport.createdAt
    } : null
  });
};

/**
 * Récupérer tous les signalements (admin) ; `format=csv` les exporte.
 * @route GET /api/reports
 */
export const getAllReports = async (req: Request, res: Response) => {
  const filters: ReportListFilters = {
    status: queryString(req.query.status),
    targetType: queryString(req.query.targetType)
  };

  if (wantsCsv(req.query.format)) {
    return sendCsvFile(res, await buildReportsCsv(filters));
  }

  return res.status(200).json(await listReports(filters, parsePagination(req.query, ALL_REPORTS_PAGE)));
};

/**
 * @route GET /api/reports/:reportId
 */
export const getReportDetail = async (req: Request, res: Response) => {
  return res.status(200).json(await loadReportDetail(String(req.params.reportId)));
};

/**
 * @route PUT /api/reports/bulk
 */
export const bulkUpdateReportStatus = async (req: Request, res: Response) => {
  const { reportIds, status, adminNotes } = req.body ?? {};
  const updated = await bulkUpdateStatus({ adminId: req.user!.id, reportIds, status, adminNotes });

  return res.status(200).json({
    message: `${updated} signalement(s) mis à jour`,
    updated
  });
};

/**
 * Mettre à jour le statut d'un signalement (admin)
 * @route PUT /api/reports/:reportId
 */
export const updateReportStatus = async (req: Request, res: Response) => {
  const { status, adminNotes } = req.body ?? {};
  const report = await updateStatus({
    adminId: req.user!.id,
    reportId: String(req.params.reportId),
    status,
    adminNotes
  });

  return res.status(200).json({
    message: 'Statut du signalement mis à jour avec succès',
    report
  });
};
