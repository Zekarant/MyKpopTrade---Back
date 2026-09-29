import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { sanitizedMulter } from '../../../commons/middlewares/sanitizedMulter';

/**
 * Seuls types acceptés, avec l'extension enregistrée pour chacun. L'extension
 * ne vient jamais du nom envoyé par le client : `sendFile` déduit le
 * Content-Type de l'extension, et un `piege.html` déclaré `image/png` aurait
 * été servi en HTML au destinataire (XSS stockée sur le domaine de l'API).
 */
const ATTACHMENT_EXTENSION_BY_MIME_TYPE = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/gif', '.gif'],
  ['application/pdf', '.pdf']
]);

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const dir = path.join(process.cwd(), 'uploads', 'chat_attachments');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    cb(null, dir);
  },
  filename: function (req, file, cb) {
    const randomName = crypto.randomBytes(16).toString('hex');
    const extension = ATTACHMENT_EXTENSION_BY_MIME_TYPE.get(file.mimetype) ?? '';
    cb(null, `${randomName}${extension}`);
  }
});

const fileFilter = (req: any, file: any, cb: any) => {
  if (ATTACHMENT_EXTENSION_BY_MIME_TYPE.has(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Type de fichier non pris en charge. Seuls JPEG, PNG, GIF et PDF sont autorisés.'), false);
  }
};

export const upload = sanitizedMulter({
  storage,
  fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024
  }
});
