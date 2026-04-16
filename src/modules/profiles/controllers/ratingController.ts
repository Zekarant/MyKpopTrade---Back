import { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { asyncHandler } from '../../../commons/middlewares/errorMiddleware';
import logger from '../../../commons/utils/logger';
import { mapHttpError } from '../../../commons/utils/httpErrorMapper';
import {
  getUserRatingsWithStats,
  createUserRating,
  reportUserRating,
  deleteRatingImageAt,
  addRatingImageForUser,
  respondToUserRating,
  updateUserRatingResponse,
  deleteUserRatingResponse
} from '../services/ratingService';

/**
 * Récupérer les évaluations d'un utilisateur
 */
export const getUserRatings = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.params.userId as string;
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 10;
  const type = req.query.type as string;

  const result = await getUserRatingsWithStats(userId, type, page, limit);
  return res.status(200).json(result);
});

/**
 * Créer une nouvelle évaluation
 */
export const createRating = asyncHandler(async (req: Request, res: Response) => {
  const reviewerId = (req.user as any).id;
  const { recipientId, review, type, transactionId } = req.body;

  const rating = parseInt(req.body.rating, 10);

  let images: string[] = [];
  if (req.files && Array.isArray(req.files)) {
    images = (req.files as Express.Multer.File[]).map(file =>
      `/uploads/ratings/${path.basename(file.path)}`
    );
  }

  try {
    const savedRating = await createUserRating({
      reviewerId,
      recipientId,
      rating,
      review,
      type,
      transactionId,
      images
    });

    return res.status(201).json({
      message: 'Évaluation créée avec succès',
      rating: savedRating
    });
  } catch (error) {
    const mapped = mapHttpError(res, error);
    if (mapped) return mapped;
    throw error;
  }
});

/**
 * Signaler une évaluation
 */
export const reportRating = asyncHandler(async (req: Request, res: Response) => {
  const ratingId = req.params.ratingId as string;
  const userId = (req.user as any).id;
  const { reason } = req.body;

  try {
    await reportUserRating(userId, ratingId, reason);
    return res.status(200).json({
      message: 'Évaluation signalée avec succès. Elle sera examinée par nos modérateurs.'
    });
  } catch (error) {
    const mapped = mapHttpError(res, error);
    if (mapped) return mapped;
    throw error;
  }
});

/**
 * Supprimer une image d'un avis
 */
export const deleteRatingImage = asyncHandler(async (req: Request, res: Response) => {
  const ratingId = req.params.ratingId as string;
  const { imageIndex } = req.body;
  const userId = (req.user as any).id;

  try {
    const images = await deleteRatingImageAt({ userId, ratingId, imageIndex });
    return res.status(200).json({
      message: 'Image supprimée avec succès',
      images
    });
  } catch (error) {
    const mapped = mapHttpError(res, error);
    if (mapped) return mapped;

    logger.error('Erreur lors de la suppression d\'une image de l\'évaluation', {
      error: error instanceof Error ? error.message : 'Erreur inconnue',
      ratingId,
      userId
    });

    return res.status(500).json({
      message: 'Une erreur est survenue lors de la suppression de l\'image'
    });
  }
});

/**
 * Ajouter une image à un avis existant
 */
export const addRatingImage = asyncHandler(async (req: Request, res: Response) => {
  const ratingId = req.params.ratingId as string;
  const userId = (req.user as any).id;

  if (!req.file) {
    return res.status(400).json({ message: 'Aucune image n\'a été téléchargée' });
  }

  try {
    const result = await addRatingImageForUser({
      userId,
      ratingId,
      filePath: req.file.path
    });

    return res.status(200).json({
      message: 'Image ajoutée avec succès',
      image: result.image,
      images: result.images
    });
  } catch (error) {
    const mapped = mapHttpError(res, error);
    if (mapped) return mapped;

    if (req.file && req.file.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    logger.error('Erreur lors de l\'ajout d\'une image à l\'évaluation', {
      error: error instanceof Error ? error.message : 'Erreur inconnue',
      ratingId,
      userId
    });

    return res.status(500).json({
      message: 'Une erreur est survenue lors de l\'ajout de l\'image'
    });
  }
});

/**
 * Répond à une évaluation (uniquement pour le destinataire de l'évaluation)
 */
export const respondToRating = asyncHandler(async (req: Request, res: Response) => {
  const ratingId = req.params.ratingId as string;
  const userId = (req.user as any).id;
  const { response } = req.body;

  try {
    const rating = await respondToUserRating(userId, ratingId, response);

    logger.info('Réponse ajoutée à une évaluation', { userId, ratingId });

    return res.status(200).json({
      message: 'Réponse ajoutée avec succès',
      rating
    });
  } catch (error) {
    const mapped = mapHttpError(res, error);
    if (mapped) return mapped;
    throw error;
  }
});

/**
 * Modifier sa réponse à une évaluation
 */
export const updateRatingResponse = asyncHandler(async (req: Request, res: Response) => {
  const ratingId = req.params.ratingId as string;
  const userId = (req.user as any).id;
  const { response } = req.body;

  try {
    const rating = await updateUserRatingResponse(userId, ratingId, response);

    logger.info('Réponse à une évaluation modifiée', { userId, ratingId });

    return res.status(200).json({
      message: 'Réponse modifiée avec succès',
      rating
    });
  } catch (error) {
    const mapped = mapHttpError(res, error);
    if (mapped) return mapped;
    throw error;
  }
});

/**
 * Supprimer sa réponse à une évaluation
 */
export const deleteRatingResponse = asyncHandler(async (req: Request, res: Response) => {
  const ratingId = req.params.ratingId as string;
  const userId = (req.user as any).id;

  try {
    await deleteUserRatingResponse(userId, ratingId);

    logger.info('Réponse à une évaluation supprimée', { userId, ratingId });

    return res.status(200).json({
      message: 'Réponse supprimée avec succès'
    });
  } catch (error) {
    const mapped = mapHttpError(res, error);
    if (mapped) return mapped;
    throw error;
  }
});
