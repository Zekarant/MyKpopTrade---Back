import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import env from '../../../config/env';
import User from '../../../models/userModel';
import { authenticateJWT } from '../../../commons/middlewares/authMiddleware';

/** `purpose` du jeton de lecture des pièces jointes. */
const ATTACHMENT_READ_PURPOSE = 'attachment_read';

/** Une heure : le temps d'une conversation, sans laisser traîner le jeton. */
export const ATTACHMENT_TOKEN_TTL_SECONDS = 60 * 60;

/**
 * Jeton qui ne permet QUE de lire les pièces jointes des conversations de
 * l'utilisateur. Il porte `userId` et non `id` : `authenticateJWT` le refuse,
 * il ne peut donc servir sur aucune autre route.
 */
export function issueAttachmentReadToken(userId: string): string {
  return jwt.sign({ userId, purpose: ATTACHMENT_READ_PURPOSE }, env.JWT_SECRET, {
    expiresIn: ATTACHMENT_TOKEN_TTL_SECONDS
  });
}

/**
 * Authentifie le téléchargement d'une pièce jointe.
 *
 * Une balise `<img src>` ou `<a href>` ne peut pas porter d'en-tête
 * `Authorization` : le jeton arrive donc dans l'URL. Ce n'est plus le jeton
 * d'accès (un « copier l'adresse de l'image » partagé ouvrait le compte
 * pendant 15 minutes) mais un jeton de lecture dédié, délivré par
 * POST /api/messaging/attachment-token. L'appartenance à la conversation reste
 * vérifiée pour chaque fichier par le contrôleur.
 *
 * Avec un en-tête Authorization, c'est l'authentification normale.
 */
export async function authenticateAttachmentRequest(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (req.headers.authorization) {
    await authenticateJWT(req, res, next);
    return;
  }

  const token = req.query.token;
  if (typeof token !== 'string' || !token) {
    res.status(401).json({ message: 'Accès non autorisé. Token manquant.' });
    return;
  }

  let userId: string | undefined;
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as { userId?: string; purpose?: string };
    userId = decoded.purpose === ATTACHMENT_READ_PURPOSE ? decoded.userId : undefined;
  } catch {
    userId = undefined;
  }
  if (!userId) {
    res.status(401).json({ message: 'Lien de pièce jointe invalide ou expiré.' });
    return;
  }

  const user = await User.findById(userId).select('accountStatus').lean<{ accountStatus?: string } | null>();
  if (!user || user.accountStatus === 'suspended' || user.accountStatus === 'deleted') {
    res.status(403).json({ message: 'Accès refusé.' });
    return;
  }

  req.user = { id: userId };
  next();
}
