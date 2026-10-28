import http from 'http';
import type { AddressInfo } from 'net';
import jwt from 'jsonwebtoken';
import { createApp } from '../../app';
import env from '../../config/env';
import { startInMemoryMongo, stopInMemoryMongo, clearAllCollections } from '../helpers/mongoMemory';
import { createTestUser } from '../helpers/fixtures';
import { generateAccessToken, JWT_ALGORITHM } from '../../commons/services/tokenService';
import Conversation from '../../models/conversationModel';
import { realtimeHub } from '../../modules/realtime';

/**
 * Flux SSE de bout en bout. supertest attend la fin de la réponse, qui
 * n'arrive jamais sur un flux : on passe par une vraie requête HTTP sur un
 * serveur éphémère, lue au fil de l'eau.
 */
const WAIT_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 20;

interface OpenStream {
  status: number | undefined;
  headers: http.IncomingHttpHeaders;
  body: () => string;
  waitFor: (text: string) => Promise<void>;
  ended: Promise<void>;
  close: () => void;
}

describe('HTTP — temps réel (SSE)', () => {
  let server: http.Server;
  let baseUrl: string;
  const openStreams: OpenStream[] = [];

  beforeAll(async () => {
    await startInMemoryMongo();
    server = createApp().listen(0);
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60000);

  afterAll(async () => {
    realtimeHub.closeAll();
    await new Promise((resolve) => server.close(resolve));
    await stopInMemoryMongo();
  });

  beforeEach(async () => {
    await clearAllCollections();
  });

  afterEach(() => {
    openStreams.splice(0).forEach((stream) => stream.close());
  });

  function openStream(token?: string): Promise<OpenStream> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
      const req = http.get(`${baseUrl}/api/realtime/stream`, { headers }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => { body += chunk; });
        const ended = new Promise<void>((resolveEnd) => res.on('end', () => resolveEnd()));

        const stream: OpenStream = {
          status: res.statusCode,
          headers: res.headers,
          body: () => body,
          ended,
          close: () => req.destroy(),
          waitFor: (text) => new Promise((resolveWait, rejectWait) => {
            const startedAt = Date.now();
            const poll = setInterval(() => {
              if (body.includes(text)) {
                clearInterval(poll);
                resolveWait();
              } else if (Date.now() - startedAt > WAIT_TIMEOUT_MS) {
                clearInterval(poll);
                rejectWait(new Error(`"${text}" non reçu. Flux : ${body}`));
              }
            }, POLL_INTERVAL_MS);
          })
        };
        openStreams.push(stream);
        resolve(stream);
      });
      req.on('error', reject);
    });
  }

  it('refuse un flux sans token', async () => {
    const stream = await openStream();

    expect(stream.status).toBe(401);
  });

  it('ouvre un flux SSE non bufferisé et envoie les compteurs initiaux', async () => {
    const alice = await createTestUser();

    const stream = await openStream(generateAccessToken(alice));

    expect(stream.status).toBe(200);
    expect(stream.headers['content-type']).toMatch(/^text\/event-stream/);
    expect(stream.headers['cache-control']).toContain('no-cache');
    expect(stream.headers['x-accel-buffering']).toBe('no');
    await stream.waitFor('retry: ');
    await stream.waitFor('event: unread:update\ndata: {"messages":0,"notifications":0}\n\n');
  });

  it('ne livre un événement publié qu\'à l\'utilisateur ciblé', async () => {
    const alice = await createTestUser();
    const bob = await createTestUser();
    const aliceStream = await openStream(generateAccessToken(alice));
    const bobStream = await openStream(generateAccessToken(bob));
    await aliceStream.waitFor('unread:update');
    await bobStream.waitFor('unread:update');

    realtimeHub.publish(String(alice._id), 'notification:new', { title: 'Pour Alice' });

    await aliceStream.waitFor('Pour Alice');
    expect(bobStream.body()).not.toContain('Pour Alice');
  });

  it('pousse le message et la notification au destinataire quand un message est envoyé', async () => {
    const alice = await createTestUser();
    const bob = await createTestUser();
    const conversation = await Conversation.create({
      participants: [alice._id, bob._id],
      createdBy: alice._id
    });
    const aliceStream = await openStream(generateAccessToken(alice));
    await aliceStream.waitFor('unread:update');

    const res = await fetch(`${baseUrl}/api/messaging/${conversation._id}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${generateAccessToken(bob)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Toujours dispo la PC de Jungkook ?' })
    });

    expect(res.status).toBe(201);
    await aliceStream.waitFor('event: message:new');
    await aliceStream.waitFor('Toujours dispo la PC de Jungkook ?');
    await aliceStream.waitFor('event: notification:new');
  });

  it('ferme le flux à l\'expiration du token d\'accès', async () => {
    const alice = await createTestUser();
    const shortLivedToken = jwt.sign({ id: String(alice._id) }, env.JWT_SECRET, {
      algorithm: JWT_ALGORITHM,
      expiresIn: 1
    });

    const stream = await openStream(shortLivedToken);
    expect(stream.status).toBe(200);

    await stream.ended;
    expect(realtimeHub.isConnected(String(alice._id))).toBe(false);
  });
});
