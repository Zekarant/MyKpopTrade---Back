import request from 'supertest';
import { Types } from 'mongoose';
import { createApp } from '../../app';
import { startInMemoryMongo, stopInMemoryMongo, clearAllCollections } from '../helpers/mongoMemory';
import { createTestUser, createTestProduct } from '../helpers/fixtures';
import { generateAccessToken } from '../../commons/services/tokenService';
import Payment from '../../models/paymentModel';
import Rating from '../../models/ratingModel';
import User from '../../models/userModel';
import TransactionProof from '../../models/transactionProofModel';

/** Avis réservés aux transactions payées, preuves non vérifiées réservées à leur auteur. */
const app = createApp();

type TestUser = Awaited<ReturnType<typeof createTestUser>>;

const auth = (user: TestUser) => `Bearer ${generateAccessToken(user)}`;

async function completedSale(buyer: TestUser, seller: TestUser, completedAt = new Date()) {
  const product = await createTestProduct(seller._id);
  const payment = await Payment.create({
    product: product._id,
    buyer: buyer._id,
    seller: seller._id,
    amount: 20,
    status: 'completed',
    completedAt
  });
  return { product, payment };
}

/** Avis tel que l'envoie le front (add_review.vue) : l'ID du produit sert de transaction. */
const reviewOf = (seller: TestUser, transactionId?: string) => ({
  recipientId: seller._id.toString(),
  rating: 5,
  review: 'Vendeur sérieux, envoi rapide',
  type: 'seller',
  ...(transactionId ? { transactionId } : {})
});

describe('HTTP — profils', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 60000);

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  beforeEach(async () => {
    await clearAllCollections();
  });

  describe('POST /api/profiles/ratings', () => {
    it('accepte l\'avis d\'un acheteur sur son vendeur pour un produit payé', async () => {
      const [buyer, seller] = [await createTestUser(), await createTestUser()];
      const { product, payment } = await completedSale(buyer, seller);

      const res = await request(app)
        .post('/api/profiles/ratings')
        .set('Authorization', auth(buyer))
        .send(reviewOf(seller, product._id.toString()));

      expect(res.status).toBe(201);
      const stored = await Rating.findOne({ reviewer: buyer._id });
      expect(stored!.transaction!.toString()).toBe(payment._id.toString());
      expect(stored!.isVerifiedPurchase).toBe(true);
    });

    it('refuse (403) un avis sans aucune transaction payée entre les deux membres', async () => {
      const [stranger, seller] = [await createTestUser(), await createTestUser()];

      const res = await request(app)
        .post('/api/profiles/ratings')
        .set('Authorization', auth(stranger))
        .send(reviewOf(seller));

      expect(res.status).toBe(403);
      expect(await Rating.countDocuments({})).toBe(0);
    });

    it('refuse (403) un paiement qui n\'est pas terminé', async () => {
      const [buyer, seller] = [await createTestUser(), await createTestUser()];
      const { payment } = await completedSale(buyer, seller);
      await Payment.updateOne({ _id: payment._id }, { $set: { status: 'pending' } });

      const res = await request(app)
        .post('/api/profiles/ratings')
        .set('Authorization', auth(buyer))
        .send(reviewOf(seller));

      expect(res.status).toBe(403);
    });

    it('refuse (409) un second avis sur la même transaction', async () => {
      const [buyer, seller] = [await createTestUser(), await createTestUser()];
      const { product } = await completedSale(buyer, seller);
      await request(app).post('/api/profiles/ratings').set('Authorization', auth(buyer)).send(reviewOf(seller, product._id.toString()));

      const res = await request(app)
        .post('/api/profiles/ratings')
        .set('Authorization', auth(buyer))
        .send(reviewOf(seller, product._id.toString()));

      expect(res.status).toBe(409);
      expect(await Rating.countDocuments({})).toBe(1);
    });

    it('sans transaction désignée, retient l\'achat le plus récent pas encore évalué', async () => {
      const [buyer, seller] = [await createTestUser(), await createTestUser()];
      const older = await completedSale(buyer, seller, new Date('2026-01-01'));
      const newer = await completedSale(buyer, seller, new Date('2026-06-01'));

      const first = await request(app).post('/api/profiles/ratings').set('Authorization', auth(buyer)).send(reviewOf(seller));
      const second = await request(app).post('/api/profiles/ratings').set('Authorization', auth(buyer)).send(reviewOf(seller));
      const third = await request(app).post('/api/profiles/ratings').set('Authorization', auth(buyer)).send(reviewOf(seller));

      expect([first.status, second.status, third.status]).toEqual([201, 201, 409]);
      const rated = (await Rating.find({}).sort({ createdAt: 1 })).map((rating) => rating.transaction!.toString());
      expect(rated).toEqual([newer.payment._id.toString(), older.payment._id.toString()]);
    });

    it('refuse (403) un vendeur qui se fait passer pour l\'acheteur de sa propre vente', async () => {
      const [buyer, seller] = [await createTestUser(), await createTestUser()];
      await completedSale(buyer, seller);

      // `type: seller` : le destinataire serait le vendeur, or c'est l'acheteur.
      const res = await request(app)
        .post('/api/profiles/ratings')
        .set('Authorization', auth(seller))
        .send(reviewOf(buyer));

      expect(res.status).toBe(403);
    });

    it('n\'intègre que les avis vérifiés dans la note moyenne', async () => {
      const [buyer, seller, other] = [await createTestUser(), await createTestUser(), await createTestUser()];
      await completedSale(buyer, seller);
      await Rating.create({
        reviewer: other._id,
        recipient: seller._id,
        rating: 1,
        review: 'Ancien avis sans achat',
        type: 'seller',
        transaction: new Types.ObjectId(),
        isVerifiedPurchase: false
      });

      await request(app).post('/api/profiles/ratings').set('Authorization', auth(buyer)).send(reviewOf(seller));

      const refreshed = await User.findById(seller._id);
      expect(refreshed!.statistics?.averageRating).toBe(5);
      expect(refreshed!.statistics?.totalRatings).toBe(1);
      const listed = await request(app).get(`/api/profiles/ratings/${seller._id}`);
      expect(listed.body.stats.averageRating).toBe(5);
    });
  });

  describe('GET /api/profiles/proofs/:userId', () => {
    async function seedProofs(owner: TestUser) {
      for (const status of ['verified', 'pending', 'rejected'] as const) {
        await TransactionProof.create({
          user: owner._id,
          type: 'sale',
          images: ['/uploads/proofs/x.jpg'],
          description: `Preuve ${status}`,
          status
        });
      }
    }

    it('ignore includeAll pour un visiteur anonyme', async () => {
      const owner = await createTestUser();
      await seedProofs(owner);

      const res = await request(app).get(`/api/profiles/proofs/${owner._id}?includeAll=1`);

      expect(res.status).toBe(200);
      expect(res.body.proofs.map((proof: { status: string }) => proof.status)).toEqual(['verified']);
    });

    it('ignore includeAll pour un autre membre', async () => {
      const [owner, other] = [await createTestUser(), await createTestUser()];
      await seedProofs(owner);

      const res = await request(app)
        .get(`/api/profiles/proofs/${owner._id}?includeAll=1`)
        .set('Authorization', auth(other));

      expect(res.body.proofs).toHaveLength(1);
    });

    it('rend toutes les preuves à leur auteur', async () => {
      const owner = await createTestUser();
      await seedProofs(owner);

      const res = await request(app)
        .get(`/api/profiles/proofs/${owner._id}?includeAll=1`)
        .set('Authorization', auth(owner));

      expect(res.body.proofs).toHaveLength(3);
    });

    it('rend toutes les preuves à un administrateur', async () => {
      const [owner, admin] = [await createTestUser(), await createTestUser({ role: 'admin' })];
      await seedProofs(owner);

      const res = await request(app)
        .get(`/api/profiles/proofs/${owner._id}?includeAll=1`)
        .set('Authorization', auth(admin));

      expect(res.body.proofs).toHaveLength(3);
    });
  });

  describe('GET /api/profiles/verification-stats/:userId', () => {
    it('répond 404, et non 500, pour un identifiant mal formé', async () => {
      const res = await request(app).get('/api/profiles/verification-stats/pas-un-id');

      expect(res.status).toBe(404);
    });
  });
});
