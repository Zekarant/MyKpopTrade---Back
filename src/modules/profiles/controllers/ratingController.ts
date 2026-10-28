import { Request, Response } from 'express';
import path from 'path';
import { HttpError } from '../../../commons/utils/httpError';
import logger from '../../../commons/utils/logger';
import {
  getUserRatingsWithStats,
  createUserRating,
  deleteRatingImageAt,
  addRatingImageForUser,
  respondToUserRating,
  updateUserRatingResponse,
  deleteUserRatingResponse
} from '../services/ratingService';
import { parsePagination } from '../../../commons/utils/pagination';
import { queryString } from '../../../commons/utils/query';

const RATINGS_PAGE_SIZE = 10;

/**
 * Récupérer les évaluations d'un utilisateur
 * @route GET /api/profiles/ratings/:userId
 */
export const getUserRatings = async (req: Request, res: Response): Promise<void> => {
  const result = await getUserRatingsWithStats(
    String(req.params.userId),
    queryString(req.query.type),
    parsePagination(req.query, { defaultLimit: RATINGS_PAGE_SIZE })
  );
  res.status(200).json(result);
};

/**
 * Créer une nouvelle évaluation
 * @route POST /api/profiles/ratings
 */
export const createRating = async (req: Request, res: Response): Promise<void> => {
  const { recipientId, review, type, transactionId } = req.body;
  const files = Array.isArray(req.files) ? req.files : [];

  const savedRating = await createUserRating({
    reviewerId: req.user!.id,
    recipientId,
    rating: parseInt(req.body.rating, 10),
    review,
    type,
    transactionId,
    images: files.map((file) => `/uploads/ratings/${path.basename(file.path)}`)
  });

  res.status(201).json({
    message: 'Évaluation créée avec succès',
    rating: savedRating
  });
};

/**
 * Supprimer une image d'un avis
 * @route DELETE /api/profiles/ratings/:ratingId/images
 */
export const deleteRatingImage = async (req: Request, res: Response): Promise<void> => {
  const images = await deleteRatingImageAt({
    userId: req.user!.id,
    ratingId: String(req.params.ratingId),
    imageIndex: req.body?.imageIndex
  });
  res.status(200).json({
    message: 'Image supprimée avec succès',
    images
  });
};

/**
 * Ajouter une image à un avis existant
 * @route POST /api/profiles/ratings/:ratingId/images
 */
export const addRatingImage = async (req: Request, res: Response): Promise<void> => {
  if (!req.file) {
    throw new HttpError(400, 'Aucune image n\'a été téléchargée', 'NO_FILE_UPLOADED');
  }

  const result = await addRatingImageForUser({
    userId: req.user!.id,
    ratingId: String(req.params.ratingId),
    filePath: req.file.path
  });

  res.status(200).json({
    message: 'Image ajoutée avec succès',
    image: result.image,
    images: result.images
  });
};

/**
 * Répond à une évaluation (uniquement pour le destinataire de l'évaluation)
 * @route POST /api/profiles/ratings/:ratingId/response
 */
export const respondToRating = async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const ratingId = String(req.params.ratingId);

  const rating = await respondToUserRating(userId, ratingId, req.body?.response);
  logger.info('Réponse ajoutée à une évaluation', { userId, ratingId });

  res.status(200).json({
    message: 'Réponse ajoutée avec succès',
    rating
  });
};

/**
 * Modifier sa réponse à une évaluation
 * @route PUT /api/profiles/ratings/:ratingId/response
 */
export const updateRatingResponse = async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const ratingId = String(req.params.ratingId);

  const rating = await updateUserRatingResponse(userId, ratingId, req.body?.response);
  logger.info('Réponse à une évaluation modifiée', { userId, ratingId });

  res.status(200).json({
    message: 'Réponse modifiée avec succès',
    rating
  });
};

/**
 * Supprimer sa réponse à une évaluation
 * @route DELETE /api/profiles/ratings/:ratingId/response
 */
export const deleteRatingResponse = async (req: Request, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const ratingId = String(req.params.ratingId);

  await deleteUserRatingResponse(userId, ratingId);
  logger.info('Réponse à une évaluation supprimée', { userId, ratingId });

  res.status(200).json({ message: 'Réponse supprimée avec succès' });
};
