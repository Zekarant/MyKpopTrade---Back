/**
 * Hub temps réel (Server-Sent Events) : garde, par utilisateur, les flux
 * ouverts et leur pousse les événements publiés par les services métier.
 *
 * ⚠️ Le hub vit dans la mémoire du process. Avec plusieurs instances de l'API
 * derrière un répartiteur, un événement publié sur l'instance A n'atteint pas
 * un client connecté à l'instance B : il faudra alors relayer les publications
 * par un pub/sub (Redis, change streams Mongo) entre instances. Inutile tant
 * que l'API tourne sur une seule instance.
 */
import env from '../../config/env';
import logger from '../../commons/utils/logger';

/** Ce dont le hub a besoin d'une réponse HTTP (express.Response le satisfait). */
export interface SseConnection {
  write(chunk: string): boolean;
  end(): void;
  /** Octets en attente d'envoi : mesure la lenteur du client. */
  readonly writableLength: number;
}

export interface RealtimeHubLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface RealtimeHubOptions {
  /** Toutes connexions confondues : chaque flux garde une socket ouverte. */
  maxConnections: number;
  /** Quelques onglets / appareils par compte suffisent. */
  maxConnectionsPerUser: number;
  /** Commentaire périodique : sans trafic, les proxys coupent la connexion. */
  heartbeatIntervalMs: number;
  logger: RealtimeHubLogger;
}

export type RegisterResult =
  | { ok: true }
  | { ok: false; reason: 'USER_LIMIT' | 'GLOBAL_LIMIT' };

/**
 * Au-delà, le client ne lit plus son flux (onglet gelé, réseau saturé) : on le
 * coupe plutôt que d'accumuler ses événements en mémoire. Il se reconnectera
 * et se resynchronisera.
 */
const MAX_BUFFERED_BYTES = 1024 * 1024;

/** setTimeout déborde au-delà (~24,8 jours) et se déclenche immédiatement. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

const HEARTBEAT_FRAME = ': heartbeat\n\n';

/** Trame SSE d'un événement nommé. JSON.stringify échappe les retours à la ligne. */
export function formatSseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export class RealtimeHub {
  private readonly connectionsByUser = new Map<string, Set<SseConnection>>();
  private readonly expiryTimers = new Map<SseConnection, NodeJS.Timeout>();
  private totalConnections = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: RealtimeHubOptions) {}

  /**
   * Enregistre un flux ouvert. Il est fermé d'office à `expiresAtMs` (expiration
   * du token d'accès qui l'a ouvert) : le client se reconnecte avec un token
   * frais, ce qui revalide la session (révocation, suspension du compte).
   */
  register(userId: string, connection: SseConnection, expiresAtMs: number): RegisterResult {
    if (this.totalConnections >= this.options.maxConnections) {
      this.options.logger.warn('realtime.connection_refused', { reason: 'GLOBAL_LIMIT', userId });
      return { ok: false, reason: 'GLOBAL_LIMIT' };
    }
    const userConnections = this.connectionsByUser.get(userId) ?? new Set<SseConnection>();
    if (userConnections.size >= this.options.maxConnectionsPerUser) {
      return { ok: false, reason: 'USER_LIMIT' };
    }

    userConnections.add(connection);
    this.connectionsByUser.set(userId, userConnections);
    this.totalConnections += 1;

    const delayMs = Math.min(Math.max(0, expiresAtMs - Date.now()), MAX_TIMER_DELAY_MS);
    const expiryTimer = setTimeout(() => this.close(userId, connection), delayMs);
    expiryTimer.unref();
    this.expiryTimers.set(connection, expiryTimer);

    this.startHeartbeat();
    return { ok: true };
  }

  /** Oublie un flux (fermé par le client ou par le hub). Idempotent. */
  unregister(userId: string, connection: SseConnection): void {
    const userConnections = this.connectionsByUser.get(userId);
    if (!userConnections?.delete(connection)) return;

    if (userConnections.size === 0) this.connectionsByUser.delete(userId);
    this.totalConnections -= 1;
    clearTimeout(this.expiryTimers.get(connection));
    this.expiryTimers.delete(connection);

    if (this.totalConnections === 0) this.stopHeartbeat();
  }

  /** Envoie un événement à tous les flux de l'utilisateur. Rend le nombre de flux atteints. */
  publish(userId: string, event: string, data: unknown): number {
    const userConnections = this.connectionsByUser.get(userId);
    if (!userConnections) return 0;

    const frame = formatSseEvent(event, data);
    // Copie : write() peut fermer un flux, donc modifier l'ensemble parcouru.
    for (const connection of [...userConnections]) {
      this.write(userId, connection, frame);
    }
    return userConnections.size;
  }

  /** Évite aux publieurs des requêtes en base quand personne n'écoute. */
  hasConnections(): boolean {
    return this.totalConnections > 0;
  }

  isConnected(userId: string): boolean {
    return this.connectionsByUser.has(userId);
  }

  connectionCount(): number {
    return this.totalConnections;
  }

  /**
   * Ferme tous les flux. À l'arrêt du serveur : server.close() attend la fin
   * des réponses en cours, et un flux SSE ne se termine jamais de lui-même.
   */
  closeAll(): void {
    for (const [userId, userConnections] of [...this.connectionsByUser]) {
      for (const connection of [...userConnections]) {
        this.close(userId, connection);
      }
    }
  }

  private close(userId: string, connection: SseConnection): void {
    this.unregister(userId, connection);
    connection.end();
  }

  private write(userId: string, connection: SseConnection, frame: string): void {
    if (connection.writableLength > MAX_BUFFERED_BYTES) {
      this.options.logger.warn('realtime.slow_client_closed', { userId });
      this.close(userId, connection);
      return;
    }
    connection.write(frame);
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      for (const [userId, userConnections] of [...this.connectionsByUser]) {
        for (const connection of [...userConnections]) {
          this.write(userId, connection, HEARTBEAT_FRAME);
        }
      }
    }, this.options.heartbeatIntervalMs);
    // Le battement seul ne doit pas maintenir le process en vie.
    this.heartbeatTimer.unref();
  }

  private stopHeartbeat(): void {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }
}

/** Quelques onglets et appareils ; au-delà, c'est une fuite côté client. */
const MAX_CONNECTIONS_PER_USER = 5;

/** Sous les 30 à 60 s d'inactivité après lesquelles les proxys coupent. */
const HEARTBEAT_INTERVAL_MS = 25_000;

/** Hub unique du process (cf. limite multi-instances en tête de fichier). */
export const realtimeHub = new RealtimeHub({
  maxConnections: env.REALTIME_MAX_CONNECTIONS,
  maxConnectionsPerUser: MAX_CONNECTIONS_PER_USER,
  heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
  logger
});
