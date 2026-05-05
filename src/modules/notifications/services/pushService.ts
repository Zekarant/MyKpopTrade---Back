import PushSubscription from '../../../models/pushSubscriptionModel';
import logger from '../../../commons/utils/logger';

/**
 * Configuration VAPID. Chargée à la première utilisation pour ne pas
 * planter le démarrage si web-push n'est pas installé. Laisser
 * VAPID_PUBLIC_KEY ou VAPID_PRIVATE_KEY non défini désactive l'envoi
 * réel (les abonnements continuent à être enregistrés, prêts à être
 * utilisés dès que les clés sont configurées).
 *
 * Génération des clés :
 *   npx web-push generate-vapid-keys
 */
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:noreply@mykpoptrade.com';

let webpushModule: any = null;
let webpushConfigured = false;

async function getWebPush(): Promise<any | null> {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return null;
  if (webpushModule) return webpushModule;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    webpushModule = require('web-push');
    if (!webpushConfigured) {
      webpushModule.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
      webpushConfigured = true;
    }
    return webpushModule;
  } catch {
    logger.warn('web-push n\'est pas installé : push désactivé');
    return null;
  }
}

export interface PushSubscriptionPayload {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushNotificationPayload {
  title: string;
  body: string;
  link?: string;
  data?: Record<string, any>;
}

/**
 * Enregistre ou met à jour un abonnement push pour un utilisateur.
 * Idempotent : un même endpoint est mis à jour plutôt que dupliqué.
 */
export async function registerSubscription(
  userId: string,
  subscription: PushSubscriptionPayload,
  userAgent?: string
): Promise<void> {
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    throw new Error('Subscription invalide');
  }
  await PushSubscription.findOneAndUpdate(
    { endpoint: subscription.endpoint },
    {
      $set: {
        user: userId,
        endpoint: subscription.endpoint,
        keys: subscription.keys,
        userAgent
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

/** Supprime un abonnement push (logout, désinscription, navigateur révoqué). */
export async function unregisterSubscription(endpoint: string, userId: string): Promise<void> {
  await PushSubscription.deleteOne({ endpoint, user: userId });
}

/**
 * Envoie une notification push à tous les abonnements d'un utilisateur.
 * Échec silencieux : un push qui plante ne doit jamais casser le flux
 * métier qui l'a déclenché. Les abonnements expirés (404/410) sont
 * automatiquement nettoyés.
 */
export async function sendToUser(
  userId: string,
  payload: PushNotificationPayload
): Promise<void> {
  const wp = await getWebPush();
  if (!wp) return;

  const subs = await PushSubscription.find({ user: userId });
  if (subs.length === 0) return;

  const body = JSON.stringify({
    title: payload.title,
    body: payload.body,
    link: payload.link,
    data: payload.data
  });

  await Promise.all(subs.map(async (sub) => {
    try {
      await wp.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }
        },
        body
      );
      sub.lastUsedAt = new Date();
      await sub.save();
    } catch (error: any) {
      const status = error?.statusCode;
      if (status === 404 || status === 410) {
        await PushSubscription.deleteOne({ _id: sub._id });
      } else {
        logger.warn('Erreur envoi push', {
          userId,
          endpoint: sub.endpoint,
          status,
          message: error?.message
        });
      }
    }
  }));
}

/** Expose la clé publique VAPID pour le front (souscription dans le navigateur). */
export function getPublicVapidKey(): string | null {
  return VAPID_PUBLIC_KEY ?? null;
}
