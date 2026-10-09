import { Request, Response } from 'express';
import { realtimeHub } from '../realtimeHub';
import { realtimePublisher } from '../services/realtimePublisher';

/**
 * Délai de reconnexion suggéré aux clients EventSource. Le client du front a
 * son propre backoff ; l'indication sert aux autres clients (outils, tests).
 */
const RECONNECT_HINT_MS = 5000;

/** Délai suggéré avant de réessayer quand le serveur est plein. */
const RETRY_AFTER_SECONDS = 30;

/**
 * GET /api/realtime/stream — flux Server-Sent Events de l'utilisateur connecté.
 *
 * Authentifié par le token d'accès habituel (authenticateJWT) : le flux est
 * fermé à l'expiration de ce token, et le client se reconnecte avec un token
 * frais. Événements : message:new, conversation:read, notification:new,
 * unread:update (cf. REALTIME_EVENTS).
 */
export function streamEvents(req: Request, res: Response): void {
  const userId = req.user!.id;
  // `exp` (en secondes) est recopié du token par authenticateJWT. L'API signe
  // toujours avec une expiration ; sans elle, le flux serait fermé aussitôt.
  const { exp } = req.user as { exp?: number };

  const registration = realtimeHub.register(userId, res, (exp ?? 0) * 1000);
  if (!registration.ok) {
    const isUserLimit = registration.reason === 'USER_LIMIT';
    res.set('Retry-After', String(RETRY_AFTER_SECONDS));
    res.status(isUserLimit ? 429 : 503).json({
      message: isUserLimit
        ? 'Trop de connexions temps réel ouvertes pour ce compte.'
        : 'Service temps réel saturé, réessayez plus tard.',
      code: registration.reason
    });
    return;
  }

  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    // no-transform : aucun proxy ne doit compresser ni réécrire le flux.
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // nginx met les réponses en tampon par défaut : les événements partiraient par paquets.
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();
  res.write(`retry: ${RECONNECT_HINT_MS}\n\n`);

  // Sur la réponse et non la requête : depuis Node 16, `req` émet 'close' dès
  // la requête lue, pas à la déconnexion du client.
  res.on('close', () => realtimeHub.unregister(userId, res));

  // Compteurs à jour dès l'ouverture : rattrape ce qui a été manqué pendant
  // une coupure, puisque les événements ne sont pas rejoués.
  realtimePublisher.publishUnreadCounts(userId);
}
