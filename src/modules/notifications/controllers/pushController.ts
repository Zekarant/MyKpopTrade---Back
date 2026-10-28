import { Request, Response } from 'express';
import {
  registerSubscription,
  unregisterSubscription,
  getPublicVapidKey
} from '../services/pushService';
import { badRequest } from '../../../commons/utils/httpError';

/** Renvoie la clé publique VAPID nécessaire à la souscription côté navigateur. */
export const getVapidPublicKey = (_req: Request, res: Response) => {
  const key = getPublicVapidKey();
  if (!key) {
    // Réponse directe : le gestionnaire central masquerait ce message attendu (5xx = bug).
    res.status(503).json({ message: 'Push non configuré sur le serveur', code: 'PUSH_NOT_CONFIGURED' });
    return;
  }
  res.status(200).json({ publicKey: key });
};

/** Enregistre un abonnement push pour l'utilisateur authentifié. */
export const subscribeToPush = async (req: Request, res: Response) => {
  const subscription = req.body?.subscription;
  if (!subscription) {
    throw badRequest('subscription requise dans le body', 'SUBSCRIPTION_REQUIRED');
  }
  const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined;

  await registerSubscription(req.user!.id, subscription, userAgent);
  res.status(201).json({ success: true });
};

/** Désinscrit un abonnement push (par endpoint). */
export const unsubscribeFromPush = async (req: Request, res: Response) => {
  const endpoint = req.body?.endpoint;
  if (!endpoint || typeof endpoint !== 'string') {
    throw badRequest('endpoint requis', 'ENDPOINT_REQUIRED');
  }
  await unregisterSubscription(endpoint, req.user!.id);
  res.status(200).json({ success: true });
};
