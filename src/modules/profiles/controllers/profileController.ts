import { Request, Response } from 'express';
import fs from 'fs';
import { asyncHandler } from '../../../commons/middlewares/errorMiddleware';
import logger from '../../../commons/utils/logger';
import { HttpError } from '../../../commons/utils/httpError';
import {
  fetchPublicProfile,
  fetchMyProfile,
  updateMyProfile,
  replaceProfileImage,
  removeProfileImage
} from '../services/profileService';

function mapHttpError(res: Response, error: unknown): Response | null {
  if (error instanceof HttpError) {
    const body: any = { message: error.message };
    const details = (error as any).details;
    if (details) Object.assign(body, details);
    return res.status(error.statusCode).json(body);
  }
  return null;
}

function cleanupUploadedFile(req: Request) {
  if (req.file && req.file.path && fs.existsSync(req.file.path)) {
    fs.unlinkSync(req.file.path);
  }
}

/**
 * Récupérer le profil public d'un utilisateur
 */
export const getPublicProfile = asyncHandler(async (req: Request, res: Response) => {
  const identifier = req.params.identifier as string;

  try {
    const result = await fetchPublicProfile(identifier);
    return res.status(200).json(result);
  } catch (error) {
    const mapped = mapHttpError(res, error);
    if (mapped) return mapped;
    throw error;
  }
});

/**
 * Récupérer les détails complets du profil (pour l'utilisateur connecté)
 */
export const getMyProfile = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;

  try {
    const result = await fetchMyProfile(userId);
    return res.status(200).json(result);
  } catch (error) {
    const mapped = mapHttpError(res, error);
    if (mapped) return mapped;
    throw error;
  }
});

/**
 * Mettre à jour mon profil
 */
export const updateProfile = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;

  try {
    const profile = await updateMyProfile(userId, req.body);
    return res.status(200).json({
      message: 'Profil mis à jour avec succès',
      profile
    });
  } catch (error) {
    const mapped = mapHttpError(res, error);
    if (mapped) return mapped;
    throw error;
  }
});

/**
 * Mettre à jour la photo de profil
 */
export const updateProfilePicture = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;

  if (!req.file) {
    return res.status(400).json({ message: 'Aucune image n\'a été téléchargée' });
  }

  try {
    const profilePicture = await replaceProfileImage({
      userId,
      field: 'profilePicture',
      uploadDir: 'profiles',
      uploadedPath: req.file.path
    });

    return res.status(200).json({
      message: 'Photo de profil mise à jour avec succès',
      profilePicture
    });
  } catch (error) {
    const mapped = mapHttpError(res, error);
    if (mapped) return mapped;

    cleanupUploadedFile(req);

    logger.error('Erreur lors de la mise à jour de la photo de profil', {
      error: error instanceof Error ? error.message : 'Erreur inconnue',
      userId
    });

    return res.status(500).json({
      message: 'Une erreur est survenue lors de la mise à jour de la photo de profil'
    });
  }
});

/**
 * Supprimer la photo de profil
 */
export const deleteProfilePicture = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;

  try {
    await removeProfileImage({
      userId,
      field: 'profilePicture',
      missingMessage: 'Aucune photo de profil à supprimer'
    });
    return res.status(200).json({
      message: 'Photo de profil supprimée avec succès'
    });
  } catch (error) {
    const mapped = mapHttpError(res, error);
    if (mapped) return mapped;

    logger.error('Erreur lors de la suppression de la photo de profil', {
      error: error instanceof Error ? error.message : 'Erreur inconnue',
      userId
    });

    return res.status(500).json({
      message: 'Une erreur est survenue lors de la suppression de la photo de profil'
    });
  }
});

/**
 * Mettre à jour la bannière de profil
 */
export const updateProfileBanner = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;

  if (!req.file) {
    return res.status(400).json({
      message: 'Aucune image n\'a été téléchargée'
    });
  }

  try {
    const profileBanner = await replaceProfileImage({
      userId,
      field: 'profileBanner',
      uploadDir: 'banners',
      uploadedPath: req.file.path
    });

    return res.status(200).json({
      message: 'Bannière de profil mise à jour avec succès',
      profileBanner
    });
  } catch (error) {
    const mapped = mapHttpError(res, error);
    if (mapped) return mapped;

    cleanupUploadedFile(req);

    logger.error('Erreur lors de la mise à jour de la bannière de profil', {
      error: error instanceof Error ? error.message : 'Erreur inconnue',
      userId
    });

    return res.status(500).json({
      message: 'Une erreur est survenue lors de la mise à jour de la bannière de profil'
    });
  }
});

/**
 * Supprimer la bannière de profil
 */
export const deleteProfileBanner = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;

  try {
    await removeProfileImage({
      userId,
      field: 'profileBanner',
      missingMessage: 'Aucune bannière de profil à supprimer'
    });
    return res.status(200).json({
      message: 'Bannière de profil supprimée avec succès'
    });
  } catch (error) {
    const mapped = mapHttpError(res, error);
    if (mapped) return mapped;

    logger.error('Erreur lors de la suppression de la bannière de profil', {
      error: error instanceof Error ? error.message : 'Erreur inconnue',
      userId
    });

    return res.status(500).json({
      message: 'Une erreur est survenue lors de la suppression de la bannière de profil'
    });
  }
});
