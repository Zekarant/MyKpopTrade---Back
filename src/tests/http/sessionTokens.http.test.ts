import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createApp } from '../../app';
import { startInMemoryMongo, stopInMemoryMongo, clearAllCollections } from '../helpers/mongoMemory';
import { createTestUser } from '../helpers/fixtures';
import env from '../../config/env';
import RefreshToken from '../../models/tokenModel';
import { generateAccessToken, generateRefreshToken } from '../../commons/services/tokenService';

/** Cycle de vie d'une session : rotation, vol de refresh token, déconnexion, révocation. */
const app = createApp();

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

/** En-tête Cookie qui présente un refresh token, comme le ferait le navigateur. */
const refreshCookie = (refreshToken: string) => `mkt_refresh=${refreshToken}`;

/** Refresh token posé par la réponse, ou undefined si le cookie est effacé. */
function refreshTokenSetBy(res: request.Response): string | undefined {
  const setCookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  const header = setCookie.find((cookie) => cookie.startsWith('mkt_refresh='));
  const value = header?.split(';')[0].slice('mkt_refresh='.length);
  return value || undefined;
}

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

  describe('POST /api/auth/login', () => {
    it('pose le refresh token dans un cookie HttpOnly, jamais dans le corps', async () => {
      const user = await createTestUser({ isEmailVerified: true });

      const res = await request(app)
        .post('/api/auth/login')
        .send({ identifier: user.email, password: 'Password1!' });

      expect(res.status).toBe(200);
      expect(res.body.accessToken).toEqual(expect.any(String));
      expect(res.body.refreshToken).toBeUndefined();
      const cookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('mkt_refresh='));
      expect(cookie).toMatch(/HttpOnly/);
      expect(cookie).toMatch(/Path=\/api\/auth/);
      expect(cookie).toMatch(/SameSite=Lax/);
    });
  });

  describe('POST /api/auth/refresh-token', () => {
    it('remplace le cookie par un nouveau refresh token et rend un jeton d\'accès utilisable', async () => {
      const { refreshToken } = await openSession();

      const res = await request(app).post('/api/auth/refresh-token').set('Cookie', refreshCookie(refreshToken));

      expect(res.status).toBe(200);
      expect(res.body.refreshToken).toBeUndefined();
      const renewed = refreshTokenSetBy(res);
      expect(renewed).toEqual(expect.any(String));
      expect(renewed).not.toBe(refreshToken);
      const profile = await request(app)
        .get('/api/auth/profile')
        .set('Authorization', `Bearer ${res.body.accessToken}`);
      expect(profile.status).toBe(200);
    });

    it('ferme la session si un refresh token déjà échangé est rejoué plus tard', async () => {
      const { refreshToken } = await openSession();
      const first = await request(app).post('/api/auth/refresh-token').set('Cookie', refreshCookie(refreshToken));
      await RefreshToken.updateOne(
        { token: sha256(refreshToken) },
        { $set: { rotatedAt: new Date(Date.now() - 60_000) } }
      );

      const replay = await request(app).post('/api/auth/refresh-token').set('Cookie', refreshCookie(refreshToken));
      const legitimate = await request(app)
        .post('/api/auth/refresh-token')
        .set('Cookie', refreshCookie(refreshTokenSetBy(first)!));

      expect(replay.status).toBe(401);
      expect(legitimate.status).toBe(401);
    });

    it('refuse une requête sans cookie de session', async () => {
      const res = await request(app).post('/api/auth/refresh-token').send({ refreshToken: 'dans-le-corps' });

      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/auth/logout', () => {
    it('révoque le jeton d\'accès et le refresh token, et efface le cookie', async () => {
      const { accessToken, refreshToken } = await openSession();

      const res = await request(app)
        .post('/api/auth/logout')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Cookie', refreshCookie(refreshToken));

      expect(res.status).toBe(200);
      expect(refreshTokenSetBy(res)).toBeUndefined();
      const profile = await request(app).get('/api/auth/profile').set('Authorization', `Bearer ${accessToken}`);
      expect(profile.status).toBe(401);
      expect(profile.body.message).toMatch(/révoqué/);
      const refresh = await request(app).post('/api/auth/refresh-token').set('Cookie', refreshCookie(refreshToken));
      expect(refresh.status).toBe(401);
    });

    it('invalide le refresh token même quand le jeton d\'accès a expiré', async () => {
      const { user, refreshToken } = await openSession();
      const expired = jwt.sign({ id: user._id, exp: Math.floor(Date.now() / 1000) - 60 }, env.JWT_SECRET);

      const res = await request(app)
        .post('/api/auth/logout')
        .set('Authorization', `Bearer ${expired}`)
        .set('Cookie', refreshCookie(refreshToken));

      expect(res.status).toBe(200);
      const refresh = await request(app).post('/api/auth/refresh-token').set('Cookie', refreshCookie(refreshToken));
      expect(refresh.status).toBe(401);
    });

    it('garde le jeton révoqué après un redémarrage de l\'API', async () => {
      const { accessToken, refreshToken } = await openSession();
      await request(app)
        .post('/api/auth/logout')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Cookie', refreshCookie(refreshToken));

      const restarted = createApp();
      const profile = await request(restarted).get('/api/auth/profile').set('Authorization', `Bearer ${accessToken}`);

      expect(profile.status).toBe(401);
    });

    it('ne révoque pas les autres sessions de l\'utilisateur', async () => {
      const { user, accessToken, refreshToken } = await openSession();
      const otherDevice = generateAccessToken({ ...user.toObject(), username: 'autre-appareil' });

      await request(app)
        .post('/api/auth/logout')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Cookie', refreshCookie(refreshToken));

      const profile = await request(app).get('/api/auth/profile').set('Authorization', `Bearer ${otherDevice}`);
      expect(profile.status).toBe(200);
    });
  });
});
