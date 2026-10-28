import request from 'supertest';
import mongoose from 'mongoose';
import { createApp } from '../../app';
import { startInMemoryMongo, stopInMemoryMongo, clearAllCollections } from '../helpers/mongoMemory';
import { createTestProduct, createTestUser } from '../helpers/fixtures';
import { generateAccessToken } from '../../commons/services/tokenService';
import User from '../../models/userModel';
import Payment from '../../models/paymentModel';

/** RGPD côté membre : consentements, export, demande de suppression, anonymisation. */
const app = createApp();

type TestUser = Awaited<ReturnType<typeof createTestUser>>;

describe('HTTP — données personnelles du membre', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 60000);

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  beforeEach(async () => {
    await clearAllCollections();
  });

  const auth = (user: TestUser) => `Bearer ${generateAccessToken(user)}`;

  it('met à jour les consentements', async () => {
    const me = await createTestUser();

    const res = await request(app)
      .put('/api/users/me/consents')
      .set('Authorization', auth(me))
      .send({ marketing: true, dataProcessing: false });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, consents: { marketing: true, dataProcessing: false } });
    expect(res.body.consents.marketingConsentAt).toBeDefined();
  });

  it('exporte mes données en pièce jointe JSON, sans mot de passe', async () => {
    const me = await createTestUser();
    await createTestProduct(me._id);

    const res = await request(app).get('/api/users/me/data-export').set('Authorization', auth(me));

    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename=user-data-[0-9a-f]{8}-\d+\.json$/);
    expect(res.body.personnalInformation.username).toBe(me.username);
    expect(res.body.personnalInformation.password).toBeUndefined();
    expect(res.body.products).toHaveLength(1);
  });

  it('exige une session', async () => {
    const res = await request(app).get('/api/users/me/data-export');

    expect(res.status).toBe(401);
  });

  describe('demande de suppression', () => {
    it('exige une confirmation explicite', async () => {
      const me = await createTestUser();

      const res = await request(app).post('/api/users/me/deletion-request').set('Authorization', auth(me)).send({});

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('CONFIRMATION_REQUIRED');
    });

    it('programme la suppression à 30 jours puis l\'annule', async () => {
      const me = await createTestUser();

      const scheduled = await request(app)
        .post('/api/users/me/deletion-request')
        .set('Authorization', auth(me))
        .send({ confirmation: true });

      expect(scheduled.status).toBe(200);
      expect(scheduled.body.success).toBe(true);
      const days = (new Date(scheduled.body.scheduledDeletionDate).getTime() - Date.now()) / 86400e3;
      expect(Math.round(days)).toBe(30);
      expect((await User.findById(me._id))?.scheduledForDeletion).toBe(true);

      const cancelled = await request(app).delete('/api/users/me/deletion-request').set('Authorization', auth(me));

      expect(cancelled.status).toBe(200);
      expect((await User.findById(me._id))?.scheduledForDeletion).toBe(false);
    });

    it('refuse d\'annuler une demande inexistante', async () => {
      const me = await createTestUser();

      const res = await request(app).delete('/api/users/me/deletion-request').set('Authorization', auth(me));

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('NO_DELETION_PENDING');
    });

    it('refuse tant qu\'un paiement est en cours', async () => {
      const me = await createTestUser();
      const seller = await createTestUser();
      await Payment.collection.insertOne({
        buyer: me._id,
        seller: seller._id,
        product: new mongoose.Types.ObjectId(),
        amount: 20,
        currency: 'EUR',
        status: 'pending'
      });

      const res = await request(app)
        .post('/api/users/me/deletion-request')
        .set('Authorization', auth(me))
        .send({ confirmation: true });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('PENDING_PAYMENTS');
      expect((await User.findById(me._id))?.scheduledForDeletion).not.toBe(true);
    });
  });

  describe('anonymisation', () => {
    it('exige une confirmation explicite', async () => {
      const me = await createTestUser();

      const res = await request(app).post('/api/users/me/anonymize').set('Authorization', auth(me)).send({ confirmation: 'oui' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('CONFIRMATION_REQUIRED');
    });

    it('remplace pseudo et email par un identifiant anonyme', async () => {
      const me = await createTestUser({ bio: 'Fan de Seventeen à Lille' });

      const res = await request(app).post('/api/users/me/anonymize').set('Authorization', auth(me)).send({ confirmation: true });

      expect(res.status).toBe(200);
      const stored = await User.findById(me._id);
      expect(stored?.username).toMatch(/^anon_[0-9a-f]{10}$/);
      expect(stored?.email).not.toBe(me.email);
      expect(stored?.bio).toBe('');
    });
  });
});
