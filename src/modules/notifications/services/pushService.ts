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

type WebPush = typeof import('web-push');

let webpushModule: WebPush | null = null;
let webpushConfigured = false;

async function getWebPush(): Promise<WebPush | null> {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return null;
  if (webpushModule) return webpushModule;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const webpush: WebPush = require('web-push');
    webpushModule = webpush;
    if (!webpushConfigured) {
      webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
      webpushConfigured = true;
    }
    return webpush;
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
  data?: Record<string, unknown>;
}

/**
 * Services de push des navigateurs (Chrome/Edge/Opera via FCM, Firefox,
 * Windows, Safari). Le serveur POST vers l'endpoint à chaque notification :
 * accepter n'importe quelle URL en ferait un relais SSRF vers le réseau interne.
 */
const PUSH_SERVICE_HOST_SUFFIXES = [
  'fcm.googleapis.com',
  'android.googleapis.com',
  'push.services.mozilla.com',
  'notify.windows.com',
  'push.apple.com'
];

export function isAllowedPushEndpoint(endpoint: unknown): boolean {
  if (typeof endpoint !== 'string') return false;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  return PUSH_SERVICE_HOST_SUFFIXES.some(
    suffix => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`)
  );
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
  if (!isAllowedPushEndpoint(subscription.endpoint)) {
    throw new Error('Subscription invalide : service de push inconnu');
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
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
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
    } catch (error) {
      const isObject = typeof error === 'object' && error !== null;
      const status = isObject && 'statusCode' in error ? error.statusCode : undefined;
      if (status === 404 || status === 410) {
        await PushSubscription.deleteOne({ _id: sub._id });
      } else {
        logger.warn('Erreur envoi push', {
          userId,
          endpoint: sub.endpoint,
          status,
          message: isObject && 'message' in error ? error.message : undefined
        });
      }
    }
  }));
}

/** Expose la clé publique VAPID pour le front (souscription dans le navigateur). */
export function getPublicVapidKey(): string | null {
  return VAPID_PUBLIC_KEY ?? null;
}
