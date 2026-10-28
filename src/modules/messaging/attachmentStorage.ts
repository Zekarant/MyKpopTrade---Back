import path from 'path';
import fs from 'fs/promises';

/** Dossier des pièces jointes de conversation (jamais servi statiquement, cf. app.ts). */
export const CHAT_ATTACHMENTS_DIR = path.join(process.cwd(), 'uploads', 'chat_attachments');

/** Chemin disque d'une pièce jointe ; `path.basename` empêche de sortir du dossier. */
export function attachmentPath(fileName: string): string {
  return path.join(CHAT_ATTACHMENTS_DIR, path.basename(fileName));
}

export async function attachmentExists(fileName: string): Promise<boolean> {
  try {
    await fs.access(attachmentPath(fileName));
    return true;
  } catch {
    return false;
  }
}

/** Supprime des fichiers déjà écrits ; un fichier absent n'est pas une erreur. */
export async function removeFiles(filePaths: string[]): Promise<void> {
  await Promise.all(filePaths.map((filePath) => fs.rm(filePath, { force: true })));
}
