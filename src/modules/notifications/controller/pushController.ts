import { Request, Response } from 'express';
import { asyncHandler } from '../../../commons/middlewares/errorMiddleware';
import {
  registerSubscription,
  unregisterSubscription,
  getPublicVapidKey
} from '../services/pushService';
import logger from '../../../commons/utils/logger';

/** Renvoie la clé publique VAPID nécessaire à la souscription côté navigateur. */
export const getVapidPublicKey = asyncHandler(async (_req: Request, res: Response) => {
  const key = getPublicVapidKey();
  if (!key) {
    return res.status(503).json({ message: 'Push non configuré sur le serveur' });
  }
  return res.status(200).json({ publicKey: key });
});

/** Enregistre un abonnement push pour l'utilisateur authentifié. */
export const subscribeToPush = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const subscription = req.body?.subscription;
  if (!subscription) {
    return res.status(400).json({ message: 'subscription requise dans le body' });
  }
  try {
    await registerSubscription(
      userId,
      subscription,
      typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined
    );
    return res.status(201).json({ success: true });
  } catch (error) {
    logger.warn('Erreur subscribe push', {
      userId,
      error: error instanceof Error ? error.message : String(error)
    });
    return res.status(400).json({ message: 'Subscription invalide' });
  }
});

/** Désinscrit un abonnement push (par endpoint). */
export const unsubscribeFromPush = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const endpoint = req.body?.endpoint;
  if (!endpoint || typeof endpoint !== 'string') {
    return res.status(400).json({ message: 'endpoint requis' });
  }
  await unregisterSubscription(endpoint, userId);
  return res.status(200).json({ success: true });
});
