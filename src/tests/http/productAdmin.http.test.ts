import request from 'supertest';
import { createApp } from '../../app';
import { startInMemoryMongo, stopInMemoryMongo, clearAllCollections } from '../helpers/mongoMemory';
import { createTestUser, createTestProduct } from '../helpers/fixtures';
import { generateAccessToken } from '../../commons/services/tokenService';
import Product, { IProductModerationFlag } from '../../models/productModel';
import AuditLog from '../../models/auditLogModel';

/** Administration des annonces : liste, export, statistiques, suppression et revue de modération. */
const app = createApp();

const moderationFlag = (overrides: Partial<IProductModerationFlag> = {}): IProductModerationFlag => ({
  suspect: true,
  confidence: 'high',
  reasoning: 'Contrefaçon probable',
  categories: ['counterfeit'],
  matchedKeywords: ['replica'],
  keywordsVersion: 'v1',
  policyVersion: 'v1',
  model: 'test-model',
  provider: 'mistral',
  analyzedAt: new Date(),
  ...overrides
});

describe('HTTP — administration des annonces', () => {
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
  const anAdmin = () => createTestUser({ role: 'admin' });

  it('refuse (403) un membre qui n\'est pas administrateur', async () => {
    const member = await createTestUser();

    const res = await request(app).get('/api/products/admin/list').set('Authorization', auth(member));

    expect(res.status).toBe(403);
  });

  describe('GET /api/products/admin/list', () => {
    it('pagine avec le format unique de pagination', async () => {
      const admin = await anAdmin();
      const seller = await createTestUser();
      await Promise.all(Array.from({ length: 3 }, () => createTestProduct(seller._id)));

      const res = await request(app).get('/api/products/admin/list?limit=2&page=2').set('Authorization', auth(admin));

      expect(res.status).toBe(200);
      expect(res.body.products).toHaveLength(1);
      expect(res.body.pagination).toEqual({ page: 2, limit: 2, total: 3, pages: 2 });
    });

    it('filtre par texte, statut et type', async () => {
      const admin = await anAdmin();
      const seller = await createTestUser();
      const suspended = await createTestProduct(seller._id, {
        title: 'Album suspect', type: 'album', isAvailable: false, moderationFlag: moderationFlag()
      });
      await createTestProduct(seller._id, { title: 'Album en vente', type: 'album' });
      await createTestProduct(seller._id, { title: 'Photocard suspecte', isAvailable: false, moderationFlag: moderationFlag() });

      const res = await request(app)
        .get('/api/products/admin/list?search=album&status=suspended&type=album')
        .set('Authorization', auth(admin));

      expect(res.body.products.map((p: { _id: string }) => p._id)).toEqual([String(suspended._id)]);
    });

    it('exporte la liste en CSV avec le statut lisible', async () => {
      const admin = await anAdmin();
      const seller = await createTestUser();
      await createTestProduct(seller._id, { title: 'Vendue', isAvailable: false, isSold: true });

      const res = await request(app).get('/api/products/admin/list?format=csv').set('Authorization', auth(admin));

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/csv/);
      expect(res.text).toContain('Vendue');
      expect(res.text).toContain(seller.email);
      expect(res.text).toContain('vendu');
    });
  });

  it('GET /api/products/admin/stats compte les annonces par statut et par type', async () => {
    const admin = await anAdmin();
    const seller = await createTestUser();
    await createTestProduct(seller._id, { price: 10 });
    await createTestProduct(seller._id, { price: 30, type: 'album', isAvailable: false, isSold: true, soldAt: new Date() });
    await createTestProduct(seller._id, { isAvailable: false, moderationFlag: moderationFlag() });

    const res = await request(app).get('/api/products/admin/stats').set('Authorization', auth(admin));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      total: 3,
      available: 1,
      sold: 1,
      suspended: 1,
      newProducts: 3,
      recentSales: 1,
      totalRevenue: 30,
      typeDistribution: { photocard: 2, album: 1 }
    });
  });

  describe('DELETE /api/products/admin/:productId', () => {
    it('supprime l\'annonce et journalise la raison', async () => {
      const admin = await anAdmin();
      const seller = await createTestUser();
      const product = await createTestProduct(seller._id);

      const res = await request(app)
        .delete(`/api/products/admin/${product._id}`)
        .set('Authorization', auth(admin))
        .send({ reason: 'Contrefaçon' });

      expect(res.status).toBe(200);
      expect(await Product.exists({ _id: product._id })).toBeNull();
      const log = await AuditLog.findOne({ action: 'delete_product' }).lean();
      expect(log?.details).toContain('Contrefaçon');
    });

    it('répond 404 pour une annonce inexistante', async () => {
      const admin = await anAdmin();

      const res = await request(app)
        .delete('/api/products/admin/507f1f77bcf86cd799439011')
        .set('Authorization', auth(admin));

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });
  });

  describe('POST /api/products/admin/:productId/moderation-review', () => {
    const review = async (productId: unknown, body: object) =>
      request(app)
        .post(`/api/products/admin/${productId}/moderation-review`)
        .set('Authorization', auth(await anAdmin()))
        .send(body);

    it('republie une annonce validée', async () => {
      const seller = await createTestUser();
      const product = await createTestProduct(seller._id, { isAvailable: false, moderationFlag: moderationFlag() });

      const res = await review(product._id, { approve: true });

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Annonce republiée');
      const reviewed = await Product.findById(product._id).lean();
      expect(reviewed?.isAvailable).toBe(true);
      expect(reviewed?.moderationFlag?.reviewDecision).toBe('approved');
    });

    it('laisse en pause une annonce dont le signalement est confirmé', async () => {
      const seller = await createTestUser();
      const product = await createTestProduct(seller._id, { isAvailable: false, moderationFlag: moderationFlag() });

      const res = await review(product._id, { approve: false });

      expect(res.status).toBe(200);
      const reviewed = await Product.findById(product._id).lean();
      expect(reviewed?.isAvailable).toBe(false);
      expect(reviewed?.moderationFlag?.reviewDecision).toBe('rejected');
    });

    it('refuse (400) une décision qui n\'est pas un booléen', async () => {
      const seller = await createTestUser();
      const product = await createTestProduct(seller._id, { isAvailable: false, moderationFlag: moderationFlag() });

      const res = await review(product._id, { approve: 'oui' });

      expect(res.status).toBe(400);
    });

    it('refuse (400) une annonce sans analyse de modération', async () => {
      const seller = await createTestUser();
      const product = await createTestProduct(seller._id);

      const res = await review(product._id, { approve: true });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('NO_MODERATION_FLAG');
    });

    it('répond 404 pour une annonce inexistante', async () => {
      const res = await review('507f1f77bcf86cd799439011', { approve: true });

      expect(res.status).toBe(404);
    });
  });
});
