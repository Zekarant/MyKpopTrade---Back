import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createApp } from '../../app';
import { startInMemoryMongo, stopInMemoryMongo, clearAllCollections } from '../helpers/mongoMemory';
import { createTestUser, createTestProduct } from '../helpers/fixtures';
import env from '../../config/env';
import Product, { IProductModerationFlag } from '../../models/productModel';
import User from '../../models/userModel';
import { generateAccessToken, revokeAccessToken } from '../../commons/services/tokenService';

/** Fiche produit publique : lien partageable /products/:id, lisible sans compte. */
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

const viewsOf = async (productId: unknown) => (await Product.findById(productId))!.views;

describe('HTTP — GET /api/products/:productId', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 60000);

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  beforeEach(async () => {
    await clearAllCollections();
  });

  describe('visiteur anonyme', () => {
    it('lit une annonce en vente sans exposer les coordonnées du vendeur', async () => {
      const seller = await createTestUser();
      const product = await createTestProduct(seller._id);

      const res = await request(app).get(`/api/products/${product._id}`);

      expect(res.status).toBe(200);
      expect(res.body.product.title).toBe(product.title);
      expect(res.body.product.seller.username).toBe(seller.username);
      expect(res.body.product.seller).not.toHaveProperty('email');
      expect(res.body.isFavorite).toBe(false);
    });

    it('ne compte pas sa consultation', async () => {
      const seller = await createTestUser();
      const product = await createTestProduct(seller._id);

      await request(app).get(`/api/products/${product._id}`);

      expect(await viewsOf(product._id)).toBe(0);
    });

    it('lit une annonce vendue sans connaître l\'acheteur', async () => {
      const seller = await createTestUser();
      const buyer = await createTestUser();
      const product = await createTestProduct(seller._id, {
        isAvailable: false,
        isSold: true,
        soldAt: new Date(),
        soldTo: buyer._id
      });

      const res = await request(app).get(`/api/products/${product._id}`);

      expect(res.status).toBe(200);
      expect(res.body.product.isSold).toBe(true);
      expect(res.body.product).not.toHaveProperty('soldTo');
    });

    it('ne voit pas l\'analyse de modération d\'une annonce validée', async () => {
      const seller = await createTestUser();
      const product = await createTestProduct(seller._id, {
        moderationFlag: moderationFlag({ reviewDecision: 'approved', reviewedAt: new Date() })
      });

      const res = await request(app).get(`/api/products/${product._id}`);

      expect(res.status).toBe(200);
      expect(res.body.product).not.toHaveProperty('moderationFlag');
    });

    it('reçoit 404 pour une annonce retirée de la vente', async () => {
      const seller = await createTestUser();
      const product = await createTestProduct(seller._id, { isAvailable: false });

      const res = await request(app).get(`/api/products/${product._id}`);

      expect(res.status).toBe(404);
    });

    it('reçoit 404 pour une annonce suspendue par la modération', async () => {
      const seller = await createTestUser();
      const product = await createTestProduct(seller._id, {
        isAvailable: false,
        moderationFlag: moderationFlag({ reviewDecision: 'rejected', reviewedAt: new Date() })
      });

      const res = await request(app).get(`/api/products/${product._id}`);

      expect(res.status).toBe(404);
    });

    it('reçoit 404 pour une annonce inexistante et 400 pour un identifiant invalide', async () => {
      const missing = await request(app).get('/api/products/507f1f77bcf86cd799439011');
      const invalid = await request(app).get('/api/products/pas-un-id');

      expect(missing.status).toBe(404);
      expect(invalid.status).toBe(400);
    });
  });

  describe('jeton inutilisable', () => {
    it('traite un jeton expiré en anonyme au lieu de répondre 401', async () => {
      const seller = await createTestUser();
      const visitor = await createTestUser();
      const product = await createTestProduct(seller._id);
      const expired = jwt.sign(
        { id: visitor._id.toString(), exp: Math.floor(Date.now() / 1000) - 60 },
        env.JWT_SECRET
      );

      const res = await request(app)
        .get(`/api/products/${product._id}`)
        .set('Authorization', `Bearer ${expired}`);

      expect(res.status).toBe(200);
      expect(await viewsOf(product._id)).toBe(0);
    });

    it('traite un jeton falsifié en anonyme', async () => {
      const seller = await createTestUser();
      const product = await createTestProduct(seller._id);
      const forged = jwt.sign({ id: seller._id.toString() }, 'pas-le-bon-secret');

      const res = await request(app)
        .get(`/api/products/${product._id}`)
        .set('Authorization', `Bearer ${forged}`);

      expect(res.status).toBe(200);
    });

    it('traite un jeton révoqué en anonyme : le vendeur déconnecté ne voit plus son annonce retirée', async () => {
      const seller = await createTestUser();
      const product = await createTestProduct(seller._id, { isAvailable: false });
      const token = generateAccessToken(seller);
      await revokeAccessToken(token);

      const res = await request(app)
        .get(`/api/products/${product._id}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
    });

    it('traite le jeton d\'un compte suspendu en anonyme', async () => {
      const seller = await createTestUser();
      const visitor = await createTestUser({ accountStatus: 'suspended' });
      const product = await createTestProduct(seller._id);

      const res = await request(app)
        .get(`/api/products/${product._id}`)
        .set('Authorization', `Bearer ${generateAccessToken(visitor)}`);

      expect(res.status).toBe(200);
      expect(await viewsOf(product._id)).toBe(0);
    });
  });

  describe('utilisateur connecté', () => {
    it('compte la consultation d\'un autre membre et indique son favori', async () => {
      const seller = await createTestUser();
      const visitor = await createTestUser();
      const product = await createTestProduct(seller._id);
      await User.updateOne({ _id: visitor._id }, { $push: { favorites: product._id } });

      const res = await request(app)
        .get(`/api/products/${product._id}`)
        .set('Authorization', `Bearer ${generateAccessToken(visitor)}`);

      expect(res.status).toBe(200);
      expect(res.body.isFavorite).toBe(true);
      expect(await viewsOf(product._id)).toBe(1);
    });

    it('ne laisse pas un autre membre voir une annonce retirée', async () => {
      const seller = await createTestUser();
      const visitor = await createTestUser();
      const product = await createTestProduct(seller._id, { isAvailable: false });

      const res = await request(app)
        .get(`/api/products/${product._id}`)
        .set('Authorization', `Bearer ${generateAccessToken(visitor)}`);

      expect(res.status).toBe(404);
    });

    it('laisse le vendeur voir son annonce suspendue, analyse de modération comprise, sans compter sa vue', async () => {
      const seller = await createTestUser();
      const product = await createTestProduct(seller._id, {
        isAvailable: false,
        moderationFlag: moderationFlag()
      });

      const res = await request(app)
        .get(`/api/products/${product._id}`)
        .set('Authorization', `Bearer ${generateAccessToken(seller)}`);

      expect(res.status).toBe(200);
      expect(res.body.product.moderationFlag.reasoning).toBe('Contrefaçon probable');
      expect(await viewsOf(product._id)).toBe(0);
    });
  });
});
