import request from 'supertest';
import { createApp } from '../../app';
import { startInMemoryMongo, stopInMemoryMongo, clearAllCollections } from '../helpers/mongoMemory';
import { createTestPayment, createTestProduct, createTestUser } from '../helpers/fixtures';
import { generateAccessToken } from '../../commons/services/tokenService';
import Dispute from '../../models/disputeModel';

/** Litiges : ouverture, échanges, retrait et arbitrage par un admin. */
const app = createApp();

type TestUser = Awaited<ReturnType<typeof createTestUser>>;
const auth = (user: TestUser) => `Bearer ${generateAccessToken(user)}`;

describe('HTTP — litiges', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 60000);

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  beforeEach(async () => {
    await clearAllCollections();
  });

  /** Vente encaissée hier, entre un acheteur et un vendeur. */
  async function completedSale() {
    const seller = await createTestUser();
    const buyer = await createTestUser();
    const product = await createTestProduct(seller._id);
    const payment = await createTestPayment(
      { product: product._id, buyer: buyer._id, seller: seller._id },
      { completedAt: new Date(Date.now() - 24 * 60 * 60 * 1000) }
    );
    return { seller, buyer, payment };
  }

  const openDispute = (user: TestUser, paymentId: string) =>
    request(app)
      .post('/api/disputes')
      .set('Authorization', auth(user))
      .send({ paymentId, reason: 'not_received', description: 'Colis jamais reçu' });

  it('laisse l\'acheteur ouvrir un litige (201)', async () => {
    const { buyer, payment } = await completedSale();

    const res = await openDispute(buyer, String(payment._id));

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ success: true, dispute: { status: 'opened', openedByRole: 'buyer' } });
  });

  it('refuse un tiers (403 DISPUTE_FORBIDDEN), au format d\'erreur unifié', async () => {
    const { payment } = await completedSale();
    const outsider = await createTestUser();

    const res = await openDispute(outsider, String(payment._id));

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ message: expect.any(String), code: 'DISPUTE_FORBIDDEN' });
  });

  it('refuse un second litige actif sur le même paiement (409)', async () => {
    const { buyer, seller, payment } = await completedSale();
    await openDispute(buyer, String(payment._id));

    const res = await openDispute(seller, String(payment._id));

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DISPUTE_ALREADY_OPEN');
  });

  it('liste mes litiges avec la pagination unifiée', async () => {
    const { buyer, payment } = await completedSale();
    await openDispute(buyer, String(payment._id));

    const res = await request(app).get('/api/disputes/me?limit=1000').set('Authorization', auth(buyer));

    expect(res.status).toBe(200);
    expect(res.body.disputes).toHaveLength(1);
    expect(res.body.pagination).toEqual({ page: 1, limit: 50, total: 1, pages: 1 });
  });

  it('montre le litige à ses parties et à un admin, pas à un tiers', async () => {
    const { buyer, seller, payment } = await completedSale();
    const admin = await createTestUser({ role: 'admin' });
    const outsider = await createTestUser();
    const { body } = await openDispute(buyer, String(payment._id));
    const url = `/api/disputes/${body.dispute._id}`;

    const statuses = await Promise.all([seller, admin, outsider].map(async (user) =>
      (await request(app).get(url).set('Authorization', auth(user))).status));

    expect(statuses).toEqual([200, 200, 403]);
  });

  it('enregistre un message d\'admin avec le rôle admin', async () => {
    const { buyer, payment } = await completedSale();
    const admin = await createTestUser({ role: 'admin' });
    const { body } = await openDispute(buyer, String(payment._id));

    const res = await request(app)
      .post(`/api/disputes/${body.dispute._id}/messages`)
      .set('Authorization', auth(admin))
      .send({ content: 'Merci de fournir le numéro de suivi.' });

    expect(res.status).toBe(200);
    const { messages } = res.body.dispute;
    expect(messages[messages.length - 1]).toMatchObject({ authorRole: 'admin' });
  });

  it('ne laisse que le plaignant retirer le litige', async () => {
    const { buyer, seller, payment } = await completedSale();
    const { body } = await openDispute(buyer, String(payment._id));
    const cancel = (user: TestUser) =>
      request(app).post(`/api/disputes/${body.dispute._id}/cancel`).set('Authorization', auth(user));

    const bySeller = await cancel(seller);
    const byBuyer = await cancel(buyer);

    expect(bySeller.status).toBe(403);
    expect(byBuyer.status).toBe(200);
    expect(byBuyer.body.dispute.status).toBe('cancelled');
  });

  it('réserve la prise en charge aux admins', async () => {
    const { buyer, payment } = await completedSale();
    const admin = await createTestUser({ role: 'admin' });
    const { body } = await openDispute(buyer, String(payment._id));
    const take = (user: TestUser) =>
      request(app).post(`/api/disputes/${body.dispute._id}/take`).set('Authorization', auth(user));

    const byBuyer = await take(buyer);
    const byAdmin = await take(admin);

    expect(byBuyer.status).toBe(403);
    expect(byAdmin.status).toBe(200);
    expect((await Dispute.findById(body.dispute._id))?.status).toBe('under_review');
  });

  it('refuse un verdict inconnu (400)', async () => {
    const { buyer, payment } = await completedSale();
    const admin = await createTestUser({ role: 'admin' });
    const { body } = await openDispute(buyer, String(payment._id));

    const res = await request(app)
      .post(`/api/disputes/${body.dispute._id}/resolve`)
      .set('Authorization', auth(admin))
      .send({ outcome: 'peut-etre' });

    expect(res.status).toBe(400);
  });

  it('liste tous les litiges pour un admin, filtrés par statut', async () => {
    const { buyer, payment } = await completedSale();
    const admin = await createTestUser({ role: 'admin' });
    await openDispute(buyer, String(payment._id));

    const opened = await request(app).get('/api/disputes?status=opened').set('Authorization', auth(admin));
    const resolved = await request(app).get('/api/disputes?status=resolved').set('Authorization', auth(admin));

    expect(opened.body.pagination.total).toBe(1);
    expect(resolved.body.disputes).toHaveLength(0);
  });
});
