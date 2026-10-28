import { Request, Response } from 'express';
import { HttpError } from '../../../commons/utils/httpError';
import {
  fetchPublicProfile,
  fetchMyProfile,
  replaceProfileImage,
  removeProfileImage
} from '../services/profileService';

const NO_IMAGE_UPLOADED_MESSAGE = 'Aucune image n\'a été téléchargée';

/** Fichier enregistré par l'upload (storedUpload), ou 400 si la requête n'en contient pas. */
function uploadedFilePath(req: Request): string {
  if (!req.file) {
    throw new HttpError(400, NO_IMAGE_UPLOADED_MESSAGE, 'NO_FILE_UPLOADED');
  }
  return req.file.path;
}

/**
 * Récupérer le profil public d'un utilisateur
 * @route GET /api/profiles/user/:identifier
 */
export const getPublicProfile = async (req: Request, res: Response): Promise<void> => {
  res.status(200).json(await fetchPublicProfile(String(req.params.identifier)));
};

/**
 * Récupérer les détails complets du profil (pour l'utilisateur connecté)
 * @route GET /api/profiles/me
 */
export const getMyProfile = async (req: Request, res: Response): Promise<void> => {
  res.status(200).json(await fetchMyProfile(req.user!.id));
};

/**
 * Mettre à jour la photo de profil
 * @route POST /api/profiles/me/picture
 */
export const updateProfilePicture = async (req: Request, res: Response): Promise<void> => {
  const profilePicture = await replaceProfileImage({
    userId: req.user!.id,
    field: 'profilePicture',
    uploadDir: 'profiles',
    uploadedPath: uploadedFilePath(req)
  });

  res.status(200).json({
    message: 'Photo de profil mise à jour avec succès',
    profilePicture
  });
};

/**
 * Supprimer la photo de profil
 * @route DELETE /api/profiles/me/picture
 */
export const deleteProfilePicture = async (req: Request, res: Response): Promise<void> => {
  await removeProfileImage({
    userId: req.user!.id,
    field: 'profilePicture',
    missingMessage: 'Aucune photo de profil à supprimer'
  });
  res.status(200).json({ message: 'Photo de profil supprimée avec succès' });
};

/**
 * Mettre à jour la bannière de profil
 * @route POST /api/profiles/me/banner
 */
export const updateProfileBanner = async (req: Request, res: Response): Promise<void> => {
  const profileBanner = await replaceProfileImage({
    userId: req.user!.id,
    field: 'profileBanner',
    uploadDir: 'banners',
    uploadedPath: uploadedFilePath(req)
  });

  res.status(200).json({
    message: 'Bannière de profil mise à jour avec succès',
    profileBanner
  });
};

/**
 * Supprimer la bannière de profil
 * @route DELETE /api/profiles/me/banner
 */
export const deleteProfileBanner = async (req: Request, res: Response): Promise<void> => {
  await removeProfileImage({
    userId: req.user!.id,
    field: 'profileBanner',
    missingMessage: 'Aucune bannière de profil à supprimer'
  });
  res.status(200).json({ message: 'Bannière de profil supprimée avec succès' });
};
