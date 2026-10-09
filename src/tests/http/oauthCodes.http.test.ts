import request from 'supertest';
import { createApp } from '../../app';
import { startInMemoryMongo, stopInMemoryMongo, clearAllCollections } from '../helpers/mongoMemory';
import { createTestUser } from '../helpers/fixtures';
import User from '../../models/userModel';
import { generateAccessToken } from '../../commons/services/tokenService';
import { issueOneTimeCode } from '../../modules/auth/services/oneTimeCodeService';

// Stratégie Google enregistrée avec des identifiants factices (createApp les
// lit à l'appel) : aucun appel réseau, on vérifie seulement la redirection.
process.env.GOOGLE_CLIENT_ID = 'client-de-test';
process.env.GOOGLE_CLIENT_SECRET = 'secret-de-test';
process.env.API_URL = 'http://api.test';
process.env.FRONTEND_URL = 'http://front.test';

/** Aucun jeton de session dans une URL : codes et tickets OAuth à usage unique. */
const app = createApp();

describe('HTTP — codes à usage unique OAuth', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 60000);

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  beforeEach(async () => {
    await clearAllCollections();
  });

  describe('POST /api/auth/oauth/exchange', () => {
    it('échange le code contre des jetons de session, une seule fois', async () => {
      const user = await createTestUser();
      const code = await issueOneTimeCode(user._id.toString(), 'oauth_login');

      const first = await request(app).post('/api/auth/oauth/exchange').send({ code });
      const replay = await request(app).post('/api/auth/oauth/exchange').send({ code });

      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({
        accessToken: expect.any(String),
        user: { id: user._id.toString(), username: user.username }
      });
      expect(first.body.refreshToken).toBeUndefined();
      expect(first.headers['set-cookie']).toEqual(
        expect.arrayContaining([expect.stringMatching(/^mkt_refresh=.+HttpOnly/)])
      );
      expect(replay.status).toBe(401);
    });

    it('refuse un ticket de liaison présenté comme code de connexion', async () => {
      const user = await createTestUser();
      const ticket = await issueOneTimeCode(user._id.toString(), 'social_link');

      const res = await request(app).post('/api/auth/oauth/exchange').send({ code: ticket });

      expect(res.status).toBe(401);
    });

    it('refuse un compte suspendu', async () => {
      const user = await createTestUser();
      await User.updateOne({ _id: user._id }, { $set: { accountStatus: 'suspended' } });
      const code = await issueOneTimeCode(user._id.toString(), 'oauth_login');

      const res = await request(app).post('/api/auth/oauth/exchange').send({ code });

      expect(res.status).toBe(403);
    });

    it('refuse un code qui n\'est pas une chaîne', async () => {
      const res = await request(app).post('/api/auth/oauth/exchange').send({ code: { $ne: '' } });

      expect(res.status).toBe(400);
    });
  });

  describe('liaison de compte', () => {
    it('délivre un ticket à un utilisateur connecté seulement', async () => {
      const user = await createTestUser();

      const anonymous = await request(app).post('/api/auth/link/google');
      const connected = await request(app)
        .post('/api/auth/link/google')
        .set('Authorization', `Bearer ${generateAccessToken(user)}`);

      expect(anonymous.status).toBe(401);
      expect(connected.status).toBe(200);
      expect(connected.body.ticket).toEqual(expect.any(String));
    });

    it('refuse un fournisseur inconnu', async () => {
      const user = await createTestUser();

      const res = await request(app)
        .post('/api/auth/link/myspace')
        .set('Authorization', `Bearer ${generateAccessToken(user)}`);

      expect(res.status).toBe(404);
    });

    it('lance la liaison avec le ticket, qui ne sert qu\'une fois', async () => {
      const user = await createTestUser();
      const { body } = await request(app)
        .post('/api/auth/link/google')
        .set('Authorization', `Bearer ${generateAccessToken(user)}`);

      const first = await request(app).get('/api/auth/google/link').query({ ticket: body.ticket });
      const replay = await request(app).get('/api/auth/google/link').query({ ticket: body.ticket });

      expect(first.status).toBe(302);
      expect(first.headers.location).toMatch(/^https:\/\/accounts\.google\.com\//);
      expect(replay.headers.location).toBe('http://front.test/settings?error=invalid_token');
    });

    it('n\'accepte plus de jeton d\'accès dans l\'URL', async () => {
      const user = await createTestUser();

      const res = await request(app)
        .get('/api/auth/google/link')
        .query({ token: generateAccessToken(user) });

      expect(res.headers.location).toBe('http://front.test/settings?error=no_token');
    });
  });
});
