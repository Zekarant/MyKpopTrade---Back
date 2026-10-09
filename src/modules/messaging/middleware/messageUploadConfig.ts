import path from 'path';
import crypto from 'crypto';
import { storedUpload, reencodeImage, PreparedUpload } from '../../../commons/middlewares/storedUpload';
import { HttpError } from '../../../commons/utils/httpError';

/**
 * Seuls types acceptés. L'extension enregistrée ne vient jamais du nom envoyé
 * par le client : `sendFile` déduit le Content-Type de l'extension, et un
 * `piege.html` déclaré `image/png` serait servi en HTML au destinataire (XSS
 * stockée sur le domaine de l'API). Les images sont ré-encodées (extension du
 * format décodé), les PDF vérifiés sur leur signature.
 */
const PDF_MIME_TYPE = 'application/pdf';
const ALLOWED_ATTACHMENT_TYPES = ['image/jpeg', 'image/png', 'image/gif', PDF_MIME_TYPE];

/** Tout PDF commence par `%PDF-`. */
const PDF_SIGNATURE = Buffer.from('%PDF-');

const MAX_ATTACHMENT_SIZE = 5 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_MESSAGE = 5;

async function preparePdf(file: Express.Multer.File): Promise<PreparedUpload> {
  if (!file.buffer.subarray(0, PDF_SIGNATURE.length).equals(PDF_SIGNATURE)) {
    throw new HttpError(400, 'Le fichier envoyé n\'est pas un PDF valide.', 'INVALID_PDF');
  }
  return { buffer: file.buffer, extension: '.pdf', mimetype: PDF_MIME_TYPE };
}

export const upload = storedUpload({
  directory: path.join(process.cwd(), 'uploads', 'chat_attachments'),
  allowedMimeTypes: ALLOWED_ATTACHMENT_TYPES,
  rejectedTypeMessage: 'Type de fichier non pris en charge. Seuls JPEG, PNG, GIF et PDF sont autorisés.',
  maxFileSize: MAX_ATTACHMENT_SIZE,
  maxFiles: MAX_ATTACHMENTS_PER_MESSAGE,
  filename: (_req, extension) => `${crypto.randomBytes(16).toString('hex')}${extension}`,
  prepare: (file) => (file.mimetype === PDF_MIME_TYPE ? preparePdf(file) : reencodeImage(file.buffer))
});
