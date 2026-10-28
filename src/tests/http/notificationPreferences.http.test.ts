import request from 'supertest';
import { createApp } from '../../app';
import { startInMemoryMongo, stopInMemoryMongo, clearAllCollections } from '../helpers/mongoMemory';
import { createTestUser } from '../helpers/fixtures';
import { generateAccessToken } from '../../commons/services/tokenService';
import { DEFAULT_NOTIFICATION_PREFERENCES } from '../../modules/notifications/notificationPreferences';

/** Préférences de notification : défauts, mise à jour partielle, liste blanche. */
const app = createApp();
const URL = '/api/users/me/notification-preferences';

describe('HTTP — préférences de notification', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 60000);

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  beforeEach(async () => {
    await clearAllCollections();
  });

  const auth = (user: Awaited<ReturnType<typeof createTestUser>>) => `Bearer ${generateAccessToken(user)}`;

  it('renvoie les défauts à un membre qui n\'a rien réglé', async () => {
    const me = await createTestUser();

    const res = await request(app).get(URL).set('Authorization', auth(me));

    expect(res.status).toBe(200);
    expect(res.body.preferences).toEqual(DEFAULT_NOTIFICATION_PREFERENCES);
  });

  it('enregistre une mise à jour partielle sans toucher aux autres réglages', async () => {
    const me = await createTestUser();

    const put = await request(app).put(URL).set('Authorization', auth(me)).send({ orders: { email: false } });
    const get = await request(app).get(URL).set('Authorization', auth(me));

    expect(put.status).toBe(200);
    expect(get.body.preferences.orders).toEqual({ email: false, push: true });
    expect(get.body.preferences.disputes).toEqual(DEFAULT_NOTIFICATION_PREFERENCES.disputes);
  });

  it('refuse une catégorie hors liste blanche, dont système', async () => {
    const me = await createTestUser();

    const res = await request(app).put(URL).set('Authorization', auth(me)).send({ system: { email: false } });

    expect(res.status).toBe(400);
    expect(res.body.details).toBeDefined();
  });

  it('refuse une valeur non booléenne', async () => {
    const me = await createTestUser();

    const res = await request(app).put(URL).set('Authorization', auth(me)).send({ offers: { push: 'non' } });

    expect(res.status).toBe(400);
    expect(res.body.details[0].field).toBe('offers.push');
  });

  it('exige d\'être connecté', async () => {
    const res = await request(app).get(URL);

    expect(res.status).toBe(401);
  });

  it('modifier les messages directs depuis le profil conserve les préférences de notification', async () => {
    const me = await createTestUser();
    await request(app).put(URL).set('Authorization', auth(me)).send({ messages: { email: true } });

    const profile = await request(app)
      .put('/api/auth/profile')
      .set('Authorization', auth(me))
      .send({ preferences: { allowDirectMessages: false } });
    const get = await request(app).get(URL).set('Authorization', auth(me));

    expect(profile.status).toBe(200);
    expect(profile.body.user.preferences.allowDirectMessages).toBe(false);
    expect(get.body.preferences.messages.email).toBe(true);
  });
});
