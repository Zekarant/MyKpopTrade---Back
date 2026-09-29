import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createApp } from '../../app';
import { startInMemoryMongo, stopInMemoryMongo, clearAllCollections } from '../helpers/mongoMemory';
import { createTestUser } from '../helpers/fixtures';
import env from '../../config/env';
import RefreshToken from '../../models/tokenModel';
import { generateAccessToken, generateRefreshToken } from '../../commons/services/tokenService';

/**
 * Cycle de vie d'une session : renouvellement à usage unique, détection d'un
 * refresh token volé, déconnexion effective même après expiration du jeton
 * d'accès, révocation qui survit à un redémarrage de l'API.
 */
const app = createApp();

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

async function openSession() {
  const user = await createTestUser();
  return {
    user,
    accessToken: generateAccessToken(user),
    refreshToken: await generateRefreshToken(user._id.toString())
  };
}

describe('HTTP — jetons de session', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 60000);

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  beforeEach(async () => {
    await clearAllCollections();
  });

  describe('POST /api/auth/refresh-token', () => {
    it('rend un nouveau refresh token et un jeton d\'accès utilisable', async () => {
      const { refreshToken } = await openSession();

      const res = await request(app).post('/api/auth/refresh-token').send({ refreshToken });

      expect(res.status).toBe(200);
      expect(res.body.refreshToken).toEqual(expect.any(String));
      expect(res.body.refreshToken).not.toBe(refreshToken);
      const profile = await request(app)
        .get('/api/auth/profile')
        .set('Authorization', `Bearer ${res.body.accessToken}`);
      expect(profile.status).toBe(200);
    });

    it('ferme la session si un refresh token déjà échangé est rejoué plus tard', async () => {
      const { refreshToken } = await openSession();
      const first = await request(app).post('/api/auth/refresh-token').send({ refreshToken });
      await RefreshToken.updateOne(
        { token: sha256(refreshToken) },
        { $set: { rotatedAt: new Date(Date.now() - 60_000) } }
      );

      const replay = await request(app).post('/api/auth/refresh-token').send({ refreshToken });
      const legitimate = await request(app)
        .post('/api/auth/refresh-token')
        .send({ refreshToken: first.body.refreshToken });

      expect(replay.status).toBe(401);
      expect(legitimate.status).toBe(401);
    });

    it('refuse un refresh token qui n\'est pas une chaîne', async () => {
      const res = await request(app).post('/api/auth/refresh-token').send({ refreshToken: { $ne: '' } });

      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/auth/logout', () => {
    it('révoque le jeton d\'accès et le refresh token', async () => {
      const { accessToken, refreshToken } = await openSession();

      const res = await request(app)
        .post('/api/auth/logout')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ refreshToken });

      expect(res.status).toBe(200);
      const profile = await request(app).get('/api/auth/profile').set('Authorization', `Bearer ${accessToken}`);
      expect(profile.status).toBe(401);
      expect(profile.body.message).toMatch(/révoqué/);
      const refresh = await request(app).post('/api/auth/refresh-token').send({ refreshToken });
      expect(refresh.status).toBe(401);
    });

    it('invalide le refresh token même quand le jeton d\'accès a expiré', async () => {
      const { user, refreshToken } = await openSession();
      const expired = jwt.sign({ id: user._id, exp: Math.floor(Date.now() / 1000) - 60 }, env.JWT_SECRET);

      const res = await request(app)
        .post('/api/auth/logout')
        .set('Authorization', `Bearer ${expired}`)
        .send({ refreshToken });

      expect(res.status).toBe(200);
      const refresh = await request(app).post('/api/auth/refresh-token').send({ refreshToken });
      expect(refresh.status).toBe(401);
    });

    it('garde le jeton révoqué après un redémarrage de l\'API', async () => {
      const { accessToken, refreshToken } = await openSession();
      await request(app).post('/api/auth/logout').set('Authorization', `Bearer ${accessToken}`).send({ refreshToken });

      const restarted = createApp();
      const profile = await request(restarted).get('/api/auth/profile').set('Authorization', `Bearer ${accessToken}`);

      expect(profile.status).toBe(401);
    });

    it('ne révoque pas les autres sessions de l\'utilisateur', async () => {
      const { user, accessToken, refreshToken } = await openSession();
      const otherDevice = generateAccessToken({ ...user.toObject(), username: 'autre-appareil' });

      await request(app).post('/api/auth/logout').set('Authorization', `Bearer ${accessToken}`).send({ refreshToken });

      const profile = await request(app).get('/api/auth/profile').set('Authorization', `Bearer ${otherDevice}`);
      expect(profile.status).toBe(200);
    });
  });
});
