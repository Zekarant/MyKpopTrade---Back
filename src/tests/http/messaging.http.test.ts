import fs from 'fs/promises';
import request from 'supertest';
import sharp from 'sharp';
import { Types } from 'mongoose';
import { createApp } from '../../app';
import { startInMemoryMongo, stopInMemoryMongo, clearAllCollections } from '../helpers/mongoMemory';
import { createTestProduct, createTestUser } from '../helpers/fixtures';
import { generateAccessToken } from '../../commons/services/tokenService';
import Conversation from '../../models/conversationModel';
import Message from '../../models/messageModel';
import { CHAT_ATTACHMENTS_DIR } from '../../modules/messaging/attachmentStorage';

/** Chemins d'erreur des contrôleurs de messagerie (statut, message, code). */
const app = createApp();

type TestUser = Awaited<ReturnType<typeof createTestUser>>;
const auth = (user: TestUser) => `Bearer ${generateAccessToken(user)}`;

async function seedConversation() {
  const alice = await createTestUser();
  const bob = await createTestUser();
  const conversation = await Conversation.create({ participants: [alice._id, bob._id], createdBy: alice._id });
  return { alice, bob, conversation };
}

const listAttachments = async () => new Set(await fs.readdir(CHAT_ATTACHMENTS_DIR));

/** La suppression a lieu après l'envoi de la réponse : on attend qu'elle aboutisse. */
async function waitUntil(condition: () => Promise<boolean>, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return condition();
}

const onePixelPng = () => sharp({ create: { width: 1, height: 1, channels: 4, background: 'red' } }).png().toBuffer();

describe('HTTP — messagerie, chemins d\'erreur', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 60000);

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  beforeEach(async () => {
    await clearAllCollections();
  });

  describe('accès aux conversations', () => {
    it('répond 404 CONVERSATION_NOT_FOUND pour une conversation inexistante', async () => {
      const res = await request(app)
        .get(`/api/messaging/${new Types.ObjectId()}`)
        .set('Authorization', auth(await createTestUser()));

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ message: 'Conversation non trouvée', code: 'CONVERSATION_NOT_FOUND' });
    });

    it('répond 403 à un membre qui n\'y participe pas', async () => {
      const { conversation } = await seedConversation();

      const res = await request(app)
        .get(`/api/messaging/${conversation._id}`)
        .set('Authorization', auth(await createTestUser()));

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('CONVERSATION_FORBIDDEN');
    });

    it('répond 400 (et non 500) à un identifiant mal formé', async () => {
      const res = await request(app).get('/api/messaging/pas-un-id').set('Authorization', auth(await createTestUser()));

      expect(res.status).toBe(400);
    });

    it('répond 404 sur une conversation close par tous ses participants', async () => {
      const { alice, conversation } = await seedConversation();
      await Conversation.updateOne({ _id: conversation._id }, { isActive: false });

      const res = await request(app).put(`/api/messaging/${conversation._id}/archive`).set('Authorization', auth(alice));

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('CONVERSATION_NOT_FOUND');
    });

    it('pagine la liste des conversations au format unifié', async () => {
      const { alice } = await seedConversation();

      const res = await request(app).get('/api/messaging').set('Authorization', auth(alice));

      expect(res.status).toBe(200);
      expect(res.body.pagination).toEqual({ page: 1, limit: 10, total: 1, pages: 1 });
    });
  });

  describe('création de conversation', () => {
    it('refuse (400) une conversation sans destinataire ou avec soi-même', async () => {
      const me = await createTestUser();

      const missing = await request(app).post('/api/messaging').set('Authorization', auth(me)).send({});
      const self = await request(app)
        .post('/api/messaging')
        .set('Authorization', auth(me))
        .send({ recipientId: String(me._id) });

      expect(missing.status).toBe(400);
      expect(missing.body.code).toBe('RECIPIENT_REQUIRED');
      expect(self.status).toBe(400);
      expect(self.body.code).toBe('SELF_CONVERSATION');
    });

    it('répond 404 pour un destinataire ou un produit inexistant', async () => {
      const me = await createTestUser();
      const recipient = await createTestUser();

      const unknownRecipient = await request(app)
        .post('/api/messaging')
        .set('Authorization', auth(me))
        .send({ recipientId: String(new Types.ObjectId()) });
      const unknownProduct = await request(app)
        .post('/api/messaging')
        .set('Authorization', auth(me))
        .send({ recipientId: String(recipient._id), productId: String(new Types.ObjectId()) });

      expect(unknownRecipient.status).toBe(404);
      expect(unknownRecipient.body.code).toBe('RECIPIENT_NOT_FOUND');
      expect(unknownProduct.status).toBe(404);
      expect(unknownProduct.body.code).toBe('PRODUCT_NOT_FOUND');
    });
  });

  describe('offres', () => {
    it('refuse (400) une action de négociation inconnue', async () => {
      const { alice, conversation } = await seedConversation();

      const res = await request(app)
        .post(`/api/messaging/${conversation._id}/respond`)
        .set('Authorization', auth(alice))
        .send({ action: 'ignorer' });

      expect(res.status).toBe(400);
      expect(res.body.message).toBe('Action invalide. Doit être accept, reject ou counter');
    });

    it('refuse (400) une offre sur son propre produit', async () => {
      const seller = await createTestUser();
      const product = await createTestProduct(seller._id, { allowOffers: true });

      const res = await request(app)
        .post('/api/messaging/negotiate')
        .set('Authorization', auth(seller))
        .send({ productId: String(product._id), initialOffer: 15 });

      expect(res.status).toBe(400);
      expect(await Conversation.countDocuments()).toBe(0);
    });

    it('répond 404 à l\'annulation sans offre en cours', async () => {
      const buyer = await createTestUser();
      const seller = await createTestUser();
      const conversation = await Conversation.create({
        participants: [buyer._id, seller._id],
        createdBy: buyer._id,
        type: 'negotiation'
      });

      const res = await request(app)
        .delete(`/api/messaging/${conversation._id}/cancel-offer`)
        .set('Authorization', auth(buyer));

      expect(res.status).toBe(404);
      expect(res.body.message).toBe('Aucune offre en cours à annuler');
    });

    it('refuse (400) une proposition de prix libre invalide', async () => {
      const { alice, conversation } = await seedConversation();

      const res = await request(app)
        .post(`/api/messaging/${conversation._id}/pwyw-offer`)
        .set('Authorization', auth(alice))
        .send({ proposedPrice: -3 });

      expect(res.status).toBe(400);
    });
  });

  describe('messages', () => {
    it('refuse (400 EMPTY_MESSAGE) un message vide', async () => {
      const { alice, conversation } = await seedConversation();

      const res = await request(app)
        .post(`/api/messaging/${conversation._id}/messages`)
        .set('Authorization', auth(alice))
        .send({ content: '   ' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('EMPTY_MESSAGE');
      expect(await Message.countDocuments()).toBe(0);
    });

    it('répond 404 au marquage ou à la suppression d\'un message inexistant', async () => {
      const me = await createTestUser();

      const read = await request(app)
        .put(`/api/messaging/messages/${new Types.ObjectId()}/read`)
        .set('Authorization', auth(me));
      const removed = await request(app)
        .delete(`/api/messaging/messages/${new Types.ObjectId()}`)
        .set('Authorization', auth(me));

      expect(read.status).toBe(404);
      expect(removed.status).toBe(404);
    });

    it('refuse (403) de marquer comme lu le message d\'une conversation étrangère', async () => {
      const { alice, conversation } = await seedConversation();
      const message = await Message.create({ conversation: conversation._id, sender: alice._id, content: 'Privé' });

      const res = await request(app)
        .put(`/api/messaging/messages/${message._id}/read`)
        .set('Authorization', auth(await createTestUser()));

      expect(res.status).toBe(403);
    });

    it('ne laisse pas supprimer le message d\'un autre membre', async () => {
      const { alice, bob, conversation } = await seedConversation();
      const message = await Message.create({ conversation: conversation._id, sender: alice._id, content: 'À moi' });

      const res = await request(app).delete(`/api/messaging/messages/${message._id}`).set('Authorization', auth(bob));

      expect(res.status).toBe(404);
      expect(await Message.exists({ _id: message._id })).not.toBeNull();
    });
  });

  describe('pièces jointes d\'un message refusé', () => {
    it('supprime du disque la pièce jointe d\'un message vide', async () => {
      const { alice, conversation } = await seedConversation();
      const before = await listAttachments();

      const res = await request(app)
        .post(`/api/messaging/${conversation._id}/messages`)
        .set('Authorization', auth(alice))
        .field('content', ' ')
        .attach('attachments', await onePixelPng(), { filename: 'photo.png', contentType: 'image/png' });

      expect(res.status).toBe(400);
      const leftovers = async () => [...await listAttachments()].filter((name) => !before.has(name));
      expect(await waitUntil(async () => (await leftovers()).length === 0)).toBe(true);
    });

    it('supprime du disque la pièce jointe d\'un message refusé pour blocage', async () => {
      const { alice, bob, conversation } = await seedConversation();
      await request(app).post(`/api/users/${alice._id}/block`).set('Authorization', auth(bob));
      const before = await listAttachments();

      const res = await request(app)
        .post(`/api/messaging/${conversation._id}/messages`)
        .set('Authorization', auth(alice))
        .field('content', 'Tu es là ?')
        .attach('attachments', await onePixelPng(), { filename: 'photo.png', contentType: 'image/png' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('BLOCKED');
      const leftovers = async () => [...await listAttachments()].filter((name) => !before.has(name));
      expect(await waitUntil(async () => (await leftovers()).length === 0)).toBe(true);
    });

    it('garde la pièce jointe d\'un message accepté', async () => {
      const { alice, conversation } = await seedConversation();

      const res = await request(app)
        .post(`/api/messaging/${conversation._id}/messages`)
        .set('Authorization', auth(alice))
        .field('content', 'Regarde')
        .attach('attachments', await onePixelPng(), { filename: 'photo.png', contentType: 'image/png' });

      expect(res.status).toBe(201);
      const [stored] = res.body.data.attachments as string[];
      try {
        // Laisse au nettoyage éventuel le temps de (ne pas) s'exécuter.
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect((await listAttachments()).has(stored)).toBe(true);
      } finally {
        await fs.rm(`${CHAT_ATTACHMENTS_DIR}/${stored}`, { force: true });
      }
    });

    it('supprime du disque les pièces jointes d\'un message supprimé', async () => {
      const { alice, conversation } = await seedConversation();
      const sent = await request(app)
        .post(`/api/messaging/${conversation._id}/messages`)
        .set('Authorization', auth(alice))
        .field('content', 'Oups')
        .attach('attachments', await onePixelPng(), { filename: 'photo.png', contentType: 'image/png' });
      const [stored] = sent.body.data.attachments as string[];

      const res = await request(app)
        .delete(`/api/messaging/messages/${sent.body.data._id}`)
        .set('Authorization', auth(alice));

      expect(res.status).toBe(200);
      expect((await listAttachments()).has(stored)).toBe(false);
    });
  });
});
