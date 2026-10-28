import request from 'supertest';
import { createApp } from '../../app';
import { startInMemoryMongo, stopInMemoryMongo, clearAllCollections } from '../helpers/mongoMemory';
import { createTestUser } from '../helpers/fixtures';
import { generateAccessToken } from '../../commons/services/tokenService';
import * as smsService from '../../commons/services/smsService';
import User from '../../models/userModel';

/** Inscription, renvoi du lien de vérification d'email et vérification du téléphone. */
const app = createApp();

type TestUser = Awaited<ReturnType<typeof createTestUser>>;

const auth = (user: TestUser) => `Bearer ${generateAccessToken(user)}`;

const PHONE = '+33612345678';
const SMS_CODE = '123456';

const registration = (overrides: Record<string, unknown> = {}) => ({
  username: 'jeanne_m',
  email: 'jeanne@test.com',
  password: 'Password1!',
  confirmPassword: 'Password1!',
  privacyPolicy: true,
  dataProcessing: true,
  ...overrides
});

const withPhoneCodeFields = (userId: unknown) =>
  User.findById(userId).select('+phoneVerificationCode +phoneVerificationAttempts');

describe('HTTP — inscription et vérifications du compte', () => {
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

  describe('POST /api/auth/register', () => {
    it('crée un compte non vérifié avec ses consentements horodatés', async () => {
      const res = await request(app).post('/api/auth/register').send(registration());

      expect(res.status).toBe(201);
      expect(res.body.consentements).toEqual({ privacyPolicy: true, dataProcessing: true, marketing: false });
      const stored = await User.findById(res.body.userId);
      expect(stored!.isEmailVerified).toBe(false);
      expect(stored!.privacyPolicyAcceptedAt).toBeInstanceOf(Date);
      expect(stored!.marketingConsentAt).toBeUndefined();
      expect(stored!.emailVerificationToken).toBeDefined();
    });

    it('refuse (400) une inscription sans acceptation de la politique de confidentialité', async () => {
      const res = await request(app).post('/api/auth/register').send(registration({ privacyPolicy: false }));

      expect(res.status).toBe(400);
      expect(await User.countDocuments({})).toBe(0);
    });

    it('refuse (400) deux mots de passe différents', async () => {
      const res = await request(app).post('/api/auth/register').send(registration({ confirmPassword: 'Autre1!x' }));

      expect(res.status).toBe(400);
    });

    it('refuse (409) un email déjà utilisé', async () => {
      await createTestUser({ email: 'jeanne@test.com' });

      const res = await request(app).post('/api/auth/register').send(registration());

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('EMAIL_ALREADY_USED');
    });

    it('refuse (409) un nom d\'utilisateur déjà pris', async () => {
      await createTestUser({ username: 'jeanne_m' });

      const res = await request(app).post('/api/auth/register').send(registration());

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('USERNAME_ALREADY_USED');
    });
  });

  describe('POST /api/auth/resend-verification', () => {
    it('refuse (400) une demande sans email', async () => {
      const res = await request(app).post('/api/auth/resend-verification').send({});

      expect(res.status).toBe(400);
    });

    it('répond pareil que l\'adresse soit inconnue, déjà vérifiée ou à vérifier (pas d\'énumération)', async () => {
      const verified = await createTestUser({ isEmailVerified: true });
      const pending = await createTestUser();
      const resend = (email: string) => request(app).post('/api/auth/resend-verification').send({ email });

      const responses = await Promise.all(['inconnu@test.com', verified.email, pending.email].map(resend));

      expect(responses.map((res) => res.status)).toEqual([200, 200, 200]);
      expect(new Set(responses.map((res) => JSON.stringify(res.body))).size).toBe(1);
    });

    it('n\'émet aucun jeton pour une adresse déjà vérifiée', async () => {
      const user = await createTestUser({ isEmailVerified: true });

      await request(app).post('/api/auth/resend-verification').send({ email: user.email });

      expect((await User.findById(user._id))!.emailVerificationToken).toBeUndefined();
    });

    it('émet un nouveau jeton de vérification pour un compte non vérifié', async () => {
      const user = await createTestUser();
      user.generateVerificationToken();
      await user.save();

      const res = await request(app).post('/api/auth/resend-verification').send({ email: user.email });

      expect(res.status).toBe(200);
      const stored = await User.findById(user._id);
      expect(stored!.emailVerificationToken).not.toBe(user.emailVerificationToken);
    });
  });

  describe('POST /api/auth/send-phone-verification', () => {
    it('refuse (400) un numéro invalide', async () => {
      const user = await createTestUser();

      const res = await request(app)
        .post('/api/auth/send-phone-verification')
        .set('Authorization', auth(user))
        .send({ phoneNumber: 'pas un numéro' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_PHONE_NUMBER');
    });

    it('refuse (409) un numéro déjà vérifié sur un autre compte, sans envoyer de SMS', async () => {
      await createTestUser({ phoneNumber: PHONE, isPhoneVerified: true });
      const user = await createTestUser();
      const sendSms = jest.spyOn(smsService, 'sendVerificationSMS');

      const res = await request(app)
        .post('/api/auth/send-phone-verification')
        .set('Authorization', auth(user))
        .send({ phoneNumber: PHONE });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('PHONE_ALREADY_USED');
      expect(sendSms).not.toHaveBeenCalled();
    });

    it('enregistre le nouveau numéro non vérifié et ne stocke que l\'empreinte du code', async () => {
      const user = await createTestUser({ phoneNumber: '+33700000000', isPhoneVerified: true });
      jest.spyOn(smsService, 'generateVerificationCode').mockReturnValue(SMS_CODE);

      const res = await request(app)
        .post('/api/auth/send-phone-verification')
        .set('Authorization', auth(user))
        .send({ phoneNumber: PHONE });

      expect(res.status).toBe(200);
      const stored = await withPhoneCodeFields(user._id);
      expect(stored!.phoneNumber).toBe(PHONE);
      expect(stored!.isPhoneVerified).toBe(false);
      expect(stored!.phoneVerificationCode).toBe(smsService.hashVerificationCode(SMS_CODE));
    });
  });

  describe('POST /api/auth/verify-phone', () => {
    async function userWithPendingCode(expiresInMs = 60_000) {
      return createTestUser({
        phoneNumber: PHONE,
        phoneVerificationCode: smsService.hashVerificationCode(SMS_CODE),
        phoneVerificationExpires: new Date(Date.now() + expiresInMs)
      });
    }

    const verify = (user: TestUser, code: string) =>
      request(app).post('/api/auth/verify-phone').set('Authorization', auth(user)).send({ code });

    it('vérifie le téléphone avec le bon code et efface le code', async () => {
      const user = await userWithPendingCode();

      const res = await verify(user, SMS_CODE);

      expect(res.status).toBe(200);
      const stored = await withPhoneCodeFields(user._id);
      expect(stored!.isPhoneVerified).toBe(true);
      expect(stored!.phoneVerificationCode).toBeUndefined();
    });

    it('refuse (400) quand aucun code n\'a été demandé', async () => {
      const user = await createTestUser();

      const res = await verify(user, SMS_CODE);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('NO_PHONE_CODE_REQUESTED');
    });

    it('refuse (400) un code expiré', async () => {
      const user = await userWithPendingCode(-1000);

      const res = await verify(user, SMS_CODE);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('PHONE_CODE_EXPIRED');
    });

    it('invalide le code au 5e essai raté', async () => {
      const user = await userWithPendingCode();

      const codes = [];
      for (let attempt = 0; attempt < 5; attempt += 1) {
        codes.push((await verify(user, '000000')).body.code);
      }

      expect(codes).toEqual([...Array(4).fill('PHONE_CODE_INVALID'), 'PHONE_CODE_ATTEMPTS_EXCEEDED']);
      expect((await verify(user, SMS_CODE)).body.code).toBe('NO_PHONE_CODE_REQUESTED');
    });

    it('refuse (409) quand un autre compte a vérifié le même numéro entre-temps', async () => {
      const user = await userWithPendingCode();
      await createTestUser({ phoneNumber: PHONE, isPhoneVerified: true });

      const res = await verify(user, SMS_CODE);

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('PHONE_ALREADY_USED');
    });
  });
});
