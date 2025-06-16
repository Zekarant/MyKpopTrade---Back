import { Request, Response } from 'express';
import mongoose from 'mongoose';
import Report from '../../../models/reportModel';
import Rating from '../../../models/ratingModel';
import Product from '../../../models/productModel';
import { asyncHandler } from '../../../commons/middlewares/errorMiddleware';
import logger from '../../../commons/utils/logger';

/**
 * Créer un nouveau signalement
 */
export const createReport = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const { targetType, targetId, reason, details } = req.body;
  
  // Validation des données
  if (!targetType || !targetId || !reason) {
    return res.status(400).json({ 
      message: 'Le type de cible, l\'ID de la cible et la raison sont obligatoires' 
    });
  }
  
  if (targetType !== 'rating' && targetType !== 'product') {
    return res.status(400).json({ 
      message: 'Type de cible invalide. Doit être "rating" ou "product"' 
    });
  }
  
  if (!mongoose.Types.ObjectId.isValid(targetId)) {
    return res.status(400).json({ message: 'ID de cible invalide' });
  }
  
  let target = null;
  
  try {
    if (targetType === 'rating') {
      target = await Rating.findById(targetId);
    } else if (targetType === 'product') {
      target = await Product.findById(targetId);
    }
  } catch (error) {
    logger.error('Erreur lors de la vérification de l\'existence de la cible:', error);
    return res.status(500).json({ message: 'Erreur lors de la vérification de la cible' });
  }
  
  if (!target) {
    return res.status(404).json({ message: 'Cible du signalement non trouvée' });
  }
  
  // Vérifier si l'utilisateur a déjà signalé cette cible
  const existingReport = await Report.findOne({
    reporter: userId,
    targetType,
    targetId
  });
  
  if (existingReport) {
    return res.status(400).json({ 
      message: 'Vous avez déjà signalé cet élément',
      reportId: existingReport._id
    });
  }
  
  // Créer le signalement
  const report = new Report({
    reporter: userId,
    targetType,
    targetId,
    reason,
    details: details || '',
    status: 'pending'
  });
  
  await report.save();
  
  logger.info('Nouveau signalement créé', {
    reportId: report._id,
    targetType,
    targetId,
    userId
  });
  
  return res.status(201).json({
    message: 'Signalement créé avec succès',
    report: {
      id: report._id,
      reason: report.reason,
      status: report.status,
      createdAt: report.createdAt
    }
  });
});

/**
 * Récupérer ses propres signalements
 */
export const getUserReports = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 10;
  const status = req.query.status as string;
  
  // Construire le filtre
  const filter: any = { reporter: userId };
  
  if (status && ['pending', 'reviewed', 'resolved', 'rejected'].includes(status)) {
    filter.status = status;
  }
  
  const [reports, count] = await Promise.all([
    Report.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Report.countDocuments(filter)
  ]);
  
  return res.status(200).json({
    reports,
    pagination: {
      page,
      limit,
      totalItems: count,
      totalPages: Math.ceil(count / limit)
    }
  });
});

/**
 * Vérifier si l'utilisateur a déjà signalé un élément
 */
export const checkUserReport = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const { targetType, targetId } = req.params;
  
  if (!targetType || !targetId) {
    return res.status(400).json({ 
      message: 'Type et ID de la cible sont requis' 
    });
  }
  
  if (targetType !== 'rating' && targetType !== 'product') {
    return res.status(400).json({ 
      message: 'Type de cible invalide. Doit être "rating" ou "product"' 
    });
  }
  
  if (!mongoose.Types.ObjectId.isValid(targetId)) {
    return res.status(400).json({ message: 'ID de cible invalide' });
  }
  
  const existingReport = await Report.findOne({
    reporter: userId,
    targetType,
    targetId
  });
  
  return res.status(200).json({
    hasReported: !!existingReport,
    report: existingReport ? {
      id: existingReport._id,
      status: existingReport.status,
      reason: existingReport.reason,
      createdAt: existingReport.createdAt
    } : null
  });
});

// FONCTIONS ADMIN CI-DESSOUS (à protéger par des middlewares d'administration)

/**
 * Récupérer tous les signalements (admin)
 */
export const getAllReports = asyncHandler(async (req: Request, res: Response) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;
  const status = req.query.status as string;
  const targetType = req.query.targetType as string;
  
  // Construire le filtre
  const filter: any = {};
  
  if (status && ['pending', 'reviewed', 'resolved', 'rejected'].includes(status)) {
    filter.status = status;
  }
  
  if (targetType && ['rating', 'product'].includes(targetType)) {
    filter.targetType = targetType;
  }
  
  const [reports, count] = await Promise.all([
    Report.find(filter)
      .populate('reporter', 'username profilePicture')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Report.countDocuments(filter)
  ]);
  
  return res.status(200).json({
    reports,
    pagination: {
      page,
      limit,
      totalItems: count,
      totalPages: Math.ceil(count / limit)
    }
  });
});

/**
 * Mettre à jour le statut d'un signalement (admin)
 */
export const updateReportStatus = asyncHandler(async (req: Request, res: Response) => {
  const { reportId } = req.params;
  const { status, adminNotes } = req.body;
  const adminId = (req.user as any).id;
  
  if (!status || !['reviewed', 'resolved', 'rejected'].includes(status)) {
    return res.status(400).json({ 
      message: 'Statut invalide. Doit être "reviewed", "resolved" ou "rejected"' 
    });
  }
  
  const report = await Report.findById(reportId);
  
  if (!report) {
    return res.status(404).json({ message: 'Signalement non trouvé' });
  }
  
  // Mettre à jour le signalement
  report.status = status;
  if (adminNotes) {
    report.adminNotes = adminNotes;
  }
  
  if (status === 'resolved') {
    report.resolvedAt = new Date();
  }
  
  await report.save();
  
  logger.info('Statut du signalement mis à jour', {
    reportId,
    adminId,
    newStatus: status
  });
  
  return res.status(200).json({
    message: 'Statut du signalement mis à jour avec succès',
    report
  });
});