import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createApp } from '../../app';
import { startInMemoryMongo, stopInMemoryMongo, clearAllCollections } from '../helpers/mongoMemory';
import { createTestUser } from '../helpers/fixtures';
import env from '../../config/env';
import User from '../../models/userModel';
import { generateAccessToken, generateRefreshToken } from '../../commons/services/tokenService';

/** Connexion, changement de mot de passe et jetons envoyés par email. */
const app = createApp();

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const refreshCookie = (refreshToken: string) => `mkt_refresh=${refreshToken}`;

describe('HTTP — durcissement de l\'authentification', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 60000);

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  beforeEach(async () => {
    await clearAllCollections();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('POST /api/auth/login', () => {
    it('refuse (400) un identifiant qui n\'est pas une chaîne', async () => {
      const user = await createTestUser({ isEmailVerified: true });

      const res = await request(app)
        .post('/api/auth/login')
        .send({ identifier: [user.email, 'autre'], password: 'Password1!' });

      expect(res.status).toBe(400);
    });

    it('refuse (400) un mot de passe qui n\'est pas une chaîne', async () => {
      const user = await createTestUser({ isEmailVerified: true });

      const res = await request(app)
        .post('/api/auth/login')
        .send({ identifier: user.email, password: ['Password1!'] });

      expect(res.status).toBe(400);
    });

    it('compare quand même un mot de passe quand le compte n\'existe pas (temps de réponse constant)', async () => {
      const compare = jest.spyOn(bcrypt, 'compare');

      const res = await request(app)
        .post('/api/auth/login')
        .send({ identifier: 'inconnu@test.com', password: 'Password1!' });

      expect(res.status).toBe(401);
      expect(compare).toHaveBeenCalledTimes(1);
    });
  });

  describe('algorithme des JWT', () => {
    it('refuse un jeton signé avec le bon secret mais un autre algorithme', async () => {
      const user = await createTestUser();
      const token = jwt.sign({ id: user._id, role: user.role }, env.JWT_SECRET, { algorithm: 'HS512', expiresIn: '5m' });

      const res = await request(app).get('/api/auth/profile').set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(401);
    });
  });

  describe('PUT /api/auth/update-password', () => {
    it('ferme les autres sessions et garde celle qui a changé le mot de passe', async () => {
      const user = await createTestUser({ isEmailVerified: true });
      const currentSession = await generateRefreshToken(user._id.toString());
      const otherDevice = await generateRefreshToken(user._id.toString());

      const res = await request(app)
        .put('/api/auth/update-password')
        .set('Authorization', `Bearer ${generateAccessToken(user)}`)
        .set('Cookie', refreshCookie(currentSession))
        .send({ currentPassword: 'Password1!', newPassword: 'Nouveau1!', confirmPassword: 'Nouveau1!' });

      expect(res.status).toBe(200);
      const stolen = await request(app).post('/api/auth/refresh-token').set('Cookie', refreshCookie(otherDevice));
      const current = await request(app).post('/api/auth/refresh-token').set('Cookie', refreshCookie(currentSession));
      expect(stolen.status).toBe(401);
      expect(current.status).toBe(200);
    });
  });

  describe('jetons envoyés par email', () => {
    it('ne stocke que l\'empreinte du jeton de réinitialisation, et accepte le jeton reçu par email', async () => {
      const user = await createTestUser({ isEmailVerified: true });
      const emailedToken = user.generatePasswordResetToken();
      await user.save();

      const stored = await User.findById(user._id);
      expect(stored!.passwordResetToken).toBe(sha256(emailedToken));

      const res = await request(app)
        .post(`/api/auth/reset-password/${emailedToken}`)
        .send({ password: 'Nouveau1!', confirmPassword: 'Nouveau1!' });
      expect(res.status).toBe(200);
    });

    it('refuse l\'empreinte lue en base comme jeton de réinitialisation', async () => {
      const user = await createTestUser({ isEmailVerified: true });
      user.generatePasswordResetToken();
      await user.save();

      const res = await request(app)
        .post(`/api/auth/reset-password/${user.passwordResetToken}`)
        .send({ password: 'Nouveau1!', confirmPassword: 'Nouveau1!' });

      expect(res.status).toBe(400);
    });

    it('ne stocke que l\'empreinte du jeton de vérification d\'email, et accepte le jeton reçu', async () => {
      const user = await createTestUser();
      const emailedToken = user.generateVerificationToken();
      await user.save();
      expect(user.emailVerificationToken).toBe(sha256(emailedToken));

      const res = await request(app).get(`/api/auth/verify-email/${emailedToken}`);

      expect(res.status).toBe(200);
      expect((await User.findById(user._id))!.isEmailVerified).toBe(true);
    });
  });
});
