import path from 'path';
import crypto from 'crypto';
import { Request } from 'express';
import { storedUpload, reencodeImage } from '../../../commons/middlewares/storedUpload';

const UPLOADS_ROOT = path.join(__dirname, '../../../../uploads');

// Premier tri sur le type déclaré ; le contenu est ensuite décodé et ré-encodé,
// et l'extension enregistrée est celle du format réellement décodé.
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif'];
const REJECTED_TYPE_MESSAGE = 'Format de fichier non supporté. Utilisez JPG, PNG ou GIF.';

const MB = 1024 * 1024;

/** Upload d'images publiques, servies depuis /uploads/<dossier>. */
function imageUpload({
  folder,
  filenamePrefix,
  maxFileSize,
  maxFiles
}: {
  folder: string;
  /** Début du nom de fichier, avant l'identifiant de l'utilisateur. */
  filenamePrefix: string;
  maxFileSize: number;
  maxFiles: number;
}) {
  return storedUpload({
    directory: path.join(UPLOADS_ROOT, folder),
    allowedMimeTypes: ALLOWED_IMAGE_TYPES,
    rejectedTypeMessage: REJECTED_TYPE_MESSAGE,
    maxFileSize,
    maxFiles,
    // L'ID de l'utilisateur + un suffixe aléatoire évitent les collisions.
    filename: (req: Request, extension: string) =>
      `${filenamePrefix}${req.user!.id}-${Date.now()}-${crypto.randomInt(1e9)}${extension}`,
    prepare: (file) => reencodeImage(file.buffer)
  });
}

export const profilePictureUpload = imageUpload({
  folder: 'profiles',
  filenamePrefix: '',
  maxFileSize: 5 * MB,
  maxFiles: 1
});

// Les bannières sont plus grandes que les photos de profil.
export const profileBannerUpload = imageUpload({
  folder: 'banners',
  filenamePrefix: 'banner-',
  maxFileSize: 10 * MB,
  maxFiles: 1
});

export const productImagesUpload = imageUpload({
  folder: 'products',
  filenamePrefix: 'product-',
  maxFileSize: 8 * MB,
  maxFiles: 10
});

export const ratingImageUpload = imageUpload({
  folder: 'ratings',
  filenamePrefix: 'rating-',
  maxFileSize: 5 * MB,
  maxFiles: 5
});
