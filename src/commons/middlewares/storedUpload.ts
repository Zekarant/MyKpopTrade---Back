import fs from 'fs';
import path from 'path';
import multer from 'multer';
import sharp from 'sharp';
import { Request, Response, NextFunction, RequestHandler } from 'express';
import { sanitizedMulter } from './sanitizedMulter';
import { HttpError } from '../utils/httpError';

/** Contenu réellement écrit sur disque pour un fichier reçu. */
export interface PreparedUpload {
  buffer: Buffer;
  extension: string;
  mimetype: string;
}

/**
 * Formats d'image acceptés. Le format retenu est celui que le décodeur a
 * reconnu, jamais le type MIME déclaré par le client.
 */
const IMAGE_OUTPUT_BY_FORMAT = {
  jpeg: { extension: '.jpg', mimetype: 'image/jpeg' },
  png: { extension: '.png', mimetype: 'image/png' },
  gif: { extension: '.gif', mimetype: 'image/gif' }
} as const;

type AcceptedImageFormat = keyof typeof IMAGE_OUTPUT_BY_FORMAT;

const isAcceptedImageFormat = (format: string | undefined): format is AcceptedImageFormat =>
  format !== undefined && Object.hasOwn(IMAGE_OUTPUT_BY_FORMAT, format);

const INVALID_IMAGE_MESSAGE = 'Le fichier envoyé n\'est pas une image JPG, PNG ou GIF valide.';

/**
 * Décode puis ré-encode une image. Le ré-encodage ne recopie pas les
 * métadonnées (EXIF, position GPS de la photo) et un fichier qui n'est pas une
 * image ne passe pas le décodeur : il ne sera jamais servi depuis /uploads.
 * `.rotate()` applique l'orientation EXIF avant qu'elle ne disparaisse.
 */
export async function reencodeImage(input: Buffer): Promise<PreparedUpload> {
  try {
    const { format } = await sharp(input).metadata();
    if (!isAcceptedImageFormat(format)) throw new HttpError(400, INVALID_IMAGE_MESSAGE, 'INVALID_IMAGE');

    const buffer = await sharp(input, { animated: format === 'gif' })
      .rotate()
      .toFormat(format)
      .toBuffer();
    return { buffer, ...IMAGE_OUTPUT_BY_FORMAT[format] };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, INVALID_IMAGE_MESSAGE, 'INVALID_IMAGE');
  }
}

/**
 * Bornes multipart communes : sans elles, multer accepte un nombre illimité de
 * champs texte de 1 Mo chacun.
 */
const MAX_TEXT_FIELDS = 20;
const MAX_FIELD_SIZE_BYTES = 100 * 1024;

interface StoredUploadOptions {
  /** Dossier de destination, créé une fois à la construction. */
  directory: string;
  /** Types MIME déclarés acceptés au premier tri ; le contenu est vérifié ensuite. */
  allowedMimeTypes: string[];
  rejectedTypeMessage: string;
  maxFileSize: number;
  maxFiles: number;
  /** Nom du fichier sur disque, extension comprise. */
  filename: (req: Request, extension: string) => string;
  /** Vérifie et transforme le contenu ; lève une HttpError pour le refuser. */
  prepare: (file: Express.Multer.File) => Promise<PreparedUpload>;
}

function receivedFiles(req: Request): Express.Multer.File[] {
  if (req.file) return [req.file];
  return Array.isArray(req.files) ? req.files : [];
}

function removeFiles(paths: string[]): void {
  for (const filePath of paths) fs.rmSync(filePath, { force: true });
}

/**
 * Upload en deux temps : multer lit les fichiers en mémoire, puis chacun est
 * vérifié (et ré-encodé pour une image) avant d'être écrit dans `directory`.
 * Aucun fichier non vérifié ne passe donc par un dossier servi publiquement.
 * Les champs `path`, `filename`, `destination`, `size` et `mimetype` des
 * fichiers sont ensuite ceux du fichier écrit, comme avec le stockage disque.
 */
export function storedUpload(options: StoredUploadOptions) {
  fs.mkdirSync(options.directory, { recursive: true });

  const parser = sanitizedMulter({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: options.maxFileSize,
      files: options.maxFiles,
      fields: MAX_TEXT_FIELDS,
      fieldSize: MAX_FIELD_SIZE_BYTES,
      parts: MAX_TEXT_FIELDS + options.maxFiles
    },
    fileFilter: (_req, file, cb) => {
      if (options.allowedMimeTypes.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new HttpError(400, options.rejectedTypeMessage, 'UNSUPPORTED_FILE_TYPE'));
      }
    }
  });

  const persist = async (req: Request): Promise<void> => {
    const written: string[] = [];
    try {
      for (const file of receivedFiles(req)) {
        const prepared = await options.prepare(file);
        const filename = options.filename(req, prepared.extension);
        const filePath = path.join(options.directory, filename);
        await fs.promises.writeFile(filePath, prepared.buffer);
        written.push(filePath);
        Object.assign(file, {
          filename,
          path: filePath,
          destination: options.directory,
          size: prepared.buffer.length,
          mimetype: prepared.mimetype
        });
      }
    } catch (error) {
      removeFiles(written);
      throw error;
    }
  };

  const thenPersist = (parse: RequestHandler): RequestHandler =>
    (req: Request, res: Response, next: NextFunction) =>
      parse(req, res, (error?: unknown) => {
        if (error instanceof multer.MulterError) {
          next(new HttpError(400, error.message, error.code));
          return;
        }
        if (error) {
          next(error);
          return;
        }
        persist(req).then(() => next(), next);
      });

  return {
    single: (fieldName: string) => thenPersist(parser.single(fieldName)),
    array: (fieldName: string, maxCount?: number) => thenPersist(parser.array(fieldName, maxCount))
  };
}
