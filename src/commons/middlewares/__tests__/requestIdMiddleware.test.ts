import express from 'express';
import request from 'supertest';
import { requestIdMiddleware } from '../requestIdMiddleware';
import { errorHandler } from '../errorMiddleware';
import { getRequestId } from '../../utils/requestContext';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** App minimale : expose l'identifiant vu par le code applicatif, après un saut asynchrone. */
function anApp() {
  const app = express();
  app.use(requestIdMiddleware);
  app.get('/id', async (_req, res) => {
    await new Promise((resolve) => setImmediate(resolve));
    res.json({ requestId: getRequestId() });
  });
  app.get('/boom', () => {
    throw new Error('bug');
  });
  app.get('/bad', () => {
    throw Object.assign(new Error('entrée invalide'), { statusCode: 400 });
  });
  app.use(errorHandler);
  return app;
}

describe('requestIdMiddleware', () => {
  it('génère un identifiant quand le client n\'en fournit pas', async () => {
    const res = await request(anApp()).get('/id');

    expect(res.headers['x-request-id']).toMatch(UUID);
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
  });

  it('reprend un identifiant entrant valide', async () => {
    const res = await request(anApp()).get('/id').set('X-Request-Id', 'proxy-abc_123.4');

    expect(res.headers['x-request-id']).toBe('proxy-abc_123.4');
    expect(res.body.requestId).toBe('proxy-abc_123.4');
  });

  it.each([
    ['caractères interdits', 'abc"}{injection'],
    ['trop long', 'a'.repeat(129)]
  ])('remplace un identifiant entrant invalide (%s)', async (_label, incomingId) => {
    const res = await request(anApp()).get('/id').set('X-Request-Id', incomingId);

    expect(res.headers['x-request-id']).toMatch(UUID);
  });

  it('isole l\'identifiant de chaque requête concurrente', async () => {
    const app = anApp();

    const responses = await Promise.all(
      ['req-1', 'req-2', 'req-3'].map((id) => request(app).get('/id').set('X-Request-Id', id))
    );

    expect(responses.map((res) => res.body.requestId)).toEqual(['req-1', 'req-2', 'req-3']);
  });

  it('renvoie l\'identifiant dans le corps d\'une erreur 500', async () => {
    const res = await request(anApp()).get('/boom').set('X-Request-Id', 'incident-42');

    expect(res.status).toBe(500);
    expect(res.body.error.requestId).toBe('incident-42');
  });

  it('ne l\'ajoute pas aux erreurs client (4xx)', async () => {
    const res = await request(anApp()).get('/bad');

    expect(res.status).toBe(400);
    expect(res.body.error).not.toHaveProperty('requestId');
  });
});
