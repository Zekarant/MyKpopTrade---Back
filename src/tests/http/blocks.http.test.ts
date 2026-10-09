import request from 'supertest';
import mongoose from 'mongoose';
import { createApp } from '../../app';
import { startInMemoryMongo, stopInMemoryMongo, clearAllCollections } from '../helpers/mongoMemory';
import { createTestProduct, createTestUser } from '../helpers/fixtures';
import { generateAccessToken } from '../../commons/services/tokenService';
import Block from '../../models/blockModel';
import Conversation from '../../models/conversationModel';
import Message from '../../models/messageModel';
import Follow from '../../modules/follows/model';

/** Blocage entre membres : gestion de la liste et refus de chaque interaction, dans les deux sens. */
const app = createApp();

type TestUser = Awaited<ReturnType<typeof createTestUser>>;

describe('HTTP — blocage', () => {
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
  const block = (blocker: TestUser, target: TestUser) =>
    request(app).post(`/api/users/${target._id}/block`).set('Authorization', auth(blocker));

  const expectBlocked = (res: request.Response) => {
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('BLOCKED');
  };

  describe('gestion des blocages', () => {
    it('bloque puis débloque un membre, sans erreur en cas de répétition', async () => {
      const me = await createTestUser();
      const alice = await createTestUser();

      const first = await block(me, alice);
      const second = await block(me, alice);
      expect([first.status, second.status]).toEqual([200, 200]);
      expect(await Block.countDocuments()).toBe(1);

      const unblock = () => request(app).delete(`/api/users/${alice._id}/block`).set('Authorization', auth(me));
      expect((await unblock()).status).toBe(200);
      expect((await unblock()).status).toBe(200);
      expect(await Block.countDocuments()).toBe(0);
    });

    it('refuse de se bloquer soi-même (400)', async () => {
      const me = await createTestUser();

      const res = await block(me, me);

      expect(res.status).toBe(400);
      expect(await Block.countDocuments()).toBe(0);
    });

    it('répond 404 pour un membre inexistant ou un identifiant invalide', async () => {
      const me = await createTestUser();

      const unknown = await request(app)
        .post(`/api/users/${new mongoose.Types.ObjectId()}/block`)
        .set('Authorization', auth(me));
      const invalid = await request(app).post('/api/users/pas-un-id/block').set('Authorization', auth(me));

      expect(unknown.status).toBe(404);
      expect(invalid.status).toBe(404);
    });

    it('exige une session', async () => {
      const alice = await createTestUser();

      const res = await request(app).post(`/api/users/${alice._id}/block`);

      expect(res.status).toBe(401);
    });

    it('liste mes membres bloqués avec pseudo et avatar, paginée', async () => {
      const me = await createTestUser();
      const alice = await createTestUser({ profilePicture: '/uploads/profiles/alice.jpg' });
      const bob = await createTestUser();
      await block(me, alice);
      await block(me, bob);
      await block(bob, me);

      const res = await request(app).get('/api/users/me/blocked?limit=1').set('Authorization', auth(me));

      expect(res.status).toBe(200);
      expect(res.body.blockedUsers).toHaveLength(1);
      expect(res.body.pagination).toMatchObject({ page: 1, limit: 1, totalItems: 2, totalPages: 2 });
      const all = await request(app).get('/api/users/me/blocked').set('Authorization', auth(me));
      expect(all.body.blockedUsers.map((u: { username: string }) => u.username).sort())
        .toEqual([alice.username, bob.username].sort());
      expect(all.body.blockedUsers.find((u: { username: string }) => u.username === alice.username).profilePicture)
        .toBe('/uploads/profiles/alice.jpg');
    });

    it('indique qui a bloqué qui', async () => {
      const me = await createTestUser();
      const alice = await createTestUser();
      await block(alice, me);

      const res = await request(app).get(`/api/users/${alice._id}/block`).set('Authorization', auth(me));

      expect(res.body).toEqual({ isBlocked: true, blockedByMe: false });
    });

    it('laisse le profil public d\'un membre bloqué consultable', async () => {
      const me = await createTestUser();
      const alice = await createTestUser();
      await block(me, alice);

      const res = await request(app).get(`/api/profiles/user/${alice._id}`).set('Authorization', auth(me));

      expect(res.status).toBe(200);
    });
  });

  describe('abonnements', () => {
    it('supprime les abonnements dans les deux sens au blocage', async () => {
      const me = await createTestUser();
      const alice = await createTestUser();
      await Follow.create([
        { follower: me._id, following: alice._id },
        { follower: alice._id, following: me._id }
      ]);

      await block(me, alice);

      expect(await Follow.countDocuments()).toBe(0);
    });

    it('refuse de suivre un membre bloqué, quel que soit le sens du blocage', async () => {
      const me = await createTestUser();
      const alice = await createTestUser();
      await block(alice, me);

      const res = await request(app).post(`/api/follows/${alice._id}/toggle`).set('Authorization', auth(me));

      expectBlocked(res);
      expect(await Follow.countDocuments()).toBe(0);
    });
  });

  describe('messagerie', () => {
    it('refuse de démarrer une conversation', async () => {
      const me = await createTestUser();
      const alice = await createTestUser();
      await block(alice, me);

      const res = await request(app)
        .post('/api/messaging')
        .set('Authorization', auth(me))
        .send({ recipientId: String(alice._id), initialMessage: 'Coucou' });

      expectBlocked(res);
      expect(await Conversation.countDocuments()).toBe(0);
    });

    it('garde une conversation existante lisible, signale le blocage mais refuse tout nouveau message', async () => {
      const me = await createTestUser();
      const alice = await createTestUser();
      const conversation = await Conversation.create({ participants: [me._id, alice._id], createdBy: me._id });
      await Message.create({ conversation: conversation._id, sender: alice._id, content: 'Ancien message' });
      await block(me, alice);

      const read = await request(app).get(`/api/messaging/${conversation._id}`).set('Authorization', auth(alice));
      const send = await request(app)
        .post(`/api/messaging/${conversation._id}/messages`)
        .set('Authorization', auth(alice))
        .send({ content: 'Tu es là ?' });

      expect(read.status).toBe(200);
      expect(read.body.messages).toHaveLength(1);
      expect(read.body.conversation).toMatchObject({ isBlocked: true, blockedByMe: false });
      expectBlocked(send);
      expect(await Message.countDocuments()).toBe(1);
    });

    it('expose blockedByMe à celui qui a bloqué', async () => {
      const me = await createTestUser();
      const alice = await createTestUser();
      const conversation = await Conversation.create({ participants: [me._id, alice._id], createdBy: me._id });
      await block(me, alice);

      const res = await request(app).get(`/api/messaging/${conversation._id}`).set('Authorization', auth(me));

      expect(res.body.conversation).toMatchObject({ isBlocked: true, blockedByMe: true });
    });

    it('refuse une offre sur l\'article d\'un membre bloqué', async () => {
      const buyer = await createTestUser();
      const seller = await createTestUser();
      const product = await createTestProduct(seller._id, { allowOffers: true });
      await block(seller, buyer);

      const res = await request(app)
        .post('/api/messaging/negotiate')
        .set('Authorization', auth(buyer))
        .send({ productId: String(product._id), initialOffer: 15 });

      expectBlocked(res);
      expect(await Conversation.countDocuments()).toBe(0);
    });

    it('refuse de répondre ou de contrer une offre après un blocage', async () => {
      const buyer = await createTestUser();
      const seller = await createTestUser();
      const product = await createTestProduct(seller._id, { allowOffers: true });
      const negotiation = await request(app)
        .post('/api/messaging/negotiate')
        .set('Authorization', auth(buyer))
        .send({ productId: String(product._id), initialOffer: 15 });
      expect(negotiation.status).toBe(201);
      await block(buyer, seller);

      const res = await request(app)
        .post(`/api/messaging/${negotiation.body.conversation._id}/respond`)
        .set('Authorization', auth(seller))
        .send({ action: 'counter', counterOffer: 18 });

      expectBlocked(res);
    });

    it('refuse une proposition de prix libre après un blocage', async () => {
      const buyer = await createTestUser();
      const seller = await createTestUser();
      const product = await createTestProduct(seller._id, { isPayWhatYouWant: true, pwywMinPrice: 5 });
      const conversation = await Conversation.create({
        participants: [buyer._id, seller._id],
        createdBy: buyer._id,
        productId: product._id
      });
      await block(seller, buyer);

      const res = await request(app)
        .post(`/api/messaging/${conversation._id}/pwyw-offer`)
        .set('Authorization', auth(buyer))
        .send({ proposedPrice: 10 });

      expectBlocked(res);
    });
  });

  describe('avis', () => {
    it('refuse de laisser un avis à un membre bloqué', async () => {
      const reviewer = await createTestUser();
      const recipient = await createTestUser();
      await block(recipient, reviewer);

      const res = await request(app)
        .post('/api/profiles/ratings')
        .set('Authorization', auth(reviewer))
        .send({ recipientId: String(recipient._id), rating: 5, review: 'Parfait', type: 'seller' });

      expectBlocked(res);
    });
  });
});
