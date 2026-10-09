import { RealtimeHub, formatSseEvent, type SseConnection } from '../realtimeHub';

const HEARTBEAT_MS = 25_000;
const IN_ONE_HOUR = () => Date.now() + 60 * 60 * 1000;

type FakeConnection = SseConnection & { frames: string[]; ended: boolean; writableLength: number };

function aConnection(): FakeConnection {
  return {
    frames: [],
    ended: false,
    writableLength: 0,
    write(chunk: string) {
      this.frames.push(chunk);
      return true;
    },
    end() {
      this.ended = true;
    }
  };
}

function aHub(overrides: Partial<{ maxConnections: number; maxConnectionsPerUser: number }> = {}) {
  return new RealtimeHub({
    maxConnections: 100,
    maxConnectionsPerUser: 5,
    heartbeatIntervalMs: HEARTBEAT_MS,
    logger: { info: jest.fn(), warn: jest.fn() },
    ...overrides
  });
}

describe('RealtimeHub', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('publie uniquement vers les flux de l\'utilisateur ciblé', () => {
    const hub = aHub();
    const alice1 = aConnection();
    const alice2 = aConnection();
    const bob = aConnection();
    hub.register('alice', alice1, IN_ONE_HOUR());
    hub.register('alice', alice2, IN_ONE_HOUR());
    hub.register('bob', bob, IN_ONE_HOUR());

    const delivered = hub.publish('alice', 'notification:new', { title: 'Coucou' });

    const expected = formatSseEvent('notification:new', { title: 'Coucou' });
    expect(delivered).toBe(2);
    expect(alice1.frames).toEqual([expected]);
    expect(alice2.frames).toEqual([expected]);
    expect(bob.frames).toEqual([]);
  });

  it('formate une trame SSE nommée sur une seule ligne de données', () => {
    expect(formatSseEvent('message:new', { content: 'a\nb' }))
      .toBe('event: message:new\ndata: {"content":"a\\nb"}\n\n');
  });

  it('ne publie plus vers un flux désenregistré, et désenregistrer deux fois est sans effet', () => {
    const hub = aHub();
    const connection = aConnection();
    hub.register('alice', connection, IN_ONE_HOUR());

    hub.unregister('alice', connection);
    hub.unregister('alice', connection);

    expect(hub.publish('alice', 'unread:update', {})).toBe(0);
    expect(hub.connectionCount()).toBe(0);
    expect(hub.isConnected('alice')).toBe(false);
  });

  it('refuse un flux de plus que la limite par utilisateur sans gêner les autres', () => {
    const hub = aHub({ maxConnectionsPerUser: 2 });
    hub.register('alice', aConnection(), IN_ONE_HOUR());
    hub.register('alice', aConnection(), IN_ONE_HOUR());

    expect(hub.register('alice', aConnection(), IN_ONE_HOUR())).toEqual({ ok: false, reason: 'USER_LIMIT' });
    expect(hub.register('bob', aConnection(), IN_ONE_HOUR())).toEqual({ ok: true });
  });

  it('refuse tout nouveau flux au-delà de la limite globale', () => {
    const hub = aHub({ maxConnections: 2 });
    hub.register('alice', aConnection(), IN_ONE_HOUR());
    hub.register('bob', aConnection(), IN_ONE_HOUR());

    expect(hub.register('carol', aConnection(), IN_ONE_HOUR())).toEqual({ ok: false, reason: 'GLOBAL_LIMIT' });
  });

  it('libère une place quand un flux se ferme', () => {
    const hub = aHub({ maxConnections: 1 });
    const first = aConnection();
    hub.register('alice', first, IN_ONE_HOUR());
    hub.unregister('alice', first);

    expect(hub.register('bob', aConnection(), IN_ONE_HOUR())).toEqual({ ok: true });
  });

  it('ferme le flux à l\'expiration du token qui l\'a ouvert', () => {
    const hub = aHub();
    const connection = aConnection();
    hub.register('alice', connection, Date.now() + 15 * 60 * 1000);

    jest.advanceTimersByTime(15 * 60 * 1000 - 1);
    expect(connection.ended).toBe(false);

    jest.advanceTimersByTime(1);
    expect(connection.ended).toBe(true);
    expect(hub.isConnected('alice')).toBe(false);
  });

  it('ferme aussitôt un flux dont le token est déjà expiré', () => {
    const hub = aHub();
    const connection = aConnection();
    hub.register('alice', connection, Date.now() - 1000);

    jest.advanceTimersByTime(0);

    expect(connection.ended).toBe(true);
  });

  it('envoie un battement de cœur périodique, arrêté quand plus personne n\'écoute', () => {
    const hub = aHub();
    const connection = aConnection();
    hub.register('alice', connection, IN_ONE_HOUR());

    jest.advanceTimersByTime(HEARTBEAT_MS);
    expect(connection.frames).toEqual([': heartbeat\n\n']);

    hub.unregister('alice', connection);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('coupe un client qui ne lit plus son flux au lieu d\'accumuler en mémoire', () => {
    const hub = aHub();
    const slow = aConnection();
    hub.register('alice', slow, IN_ONE_HOUR());
    slow.writableLength = 2 * 1024 * 1024;

    hub.publish('alice', 'message:new', {});

    expect(slow.frames).toEqual([]);
    expect(slow.ended).toBe(true);
    expect(hub.isConnected('alice')).toBe(false);
  });

  it('closeAll ferme tous les flux et annule les minuteurs', () => {
    const hub = aHub();
    const connections = [aConnection(), aConnection(), aConnection()];
    hub.register('alice', connections[0], IN_ONE_HOUR());
    hub.register('alice', connections[1], IN_ONE_HOUR());
    hub.register('bob', connections[2], IN_ONE_HOUR());

    hub.closeAll();

    expect(connections.every((connection) => connection.ended)).toBe(true);
    expect(hub.hasConnections()).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });
});
