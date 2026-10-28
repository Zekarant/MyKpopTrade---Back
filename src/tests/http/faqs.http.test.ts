import request from 'supertest';
import { createApp } from '../../app';
import { startInMemoryMongo, stopInMemoryMongo, clearAllCollections } from '../helpers/mongoMemory';
import { createTestUser } from '../helpers/fixtures';
import { generateAccessToken } from '../../commons/services/tokenService';
import Faq from '../../models/faqModel';

/** FAQ : liste publique des questions publiées, gestion réservée aux administrateurs. */
const app = createApp();

describe('HTTP — FAQ', () => {
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
  const asAdmin = async () => auth(await createTestUser({ role: 'admin' }));
  const aFaq = (overrides: Record<string, unknown> = {}) =>
    Faq.create({ question: 'Comment vendre ?', answer: 'Créez une annonce.', ...overrides });

  describe('GET /api/faqs', () => {
    it('liste les seules FAQ publiées, triées par catégorie puis ordre', async () => {
      await aFaq({ question: 'Paiement 2', category: 'paiement', order: 2 });
      await aFaq({ question: 'Paiement 1', category: 'paiement', order: 1 });
      await aFaq({ question: 'Compte', category: 'compte' });
      await aFaq({ question: 'Brouillon', isPublished: false });

      const res = await request(app).get('/api/faqs');

      expect(res.status).toBe(200);
      expect(res.body.faqs.map((faq: { question: string }) => faq.question)).toEqual(['Compte', 'Paiement 1', 'Paiement 2']);
    });
  });

  describe('administration', () => {
    it('refuse (403) un membre qui n\'est pas administrateur', async () => {
      const member = await createTestUser();

      const res = await request(app).get('/api/faqs/admin/list').set('Authorization', auth(member));

      expect(res.status).toBe(403);
    });

    it('liste aussi les brouillons', async () => {
      await aFaq();
      await aFaq({ isPublished: false });

      const res = await request(app).get('/api/faqs/admin/list').set('Authorization', await asAdmin());

      expect(res.body.faqs).toHaveLength(2);
    });

    it('crée une FAQ avec les valeurs par défaut', async () => {
      const res = await request(app)
        .post('/api/faqs/admin')
        .set('Authorization', await asAdmin())
        .send({ question: '  Comment payer ?  ', answer: 'Par PayPal.' });

      expect(res.status).toBe(201);
      expect(res.body.faq).toMatchObject({ question: 'Comment payer ?', category: 'general', order: 0, isPublished: true });
    });

    it.each([
      ['sans réponse', { question: 'Q ?' }],
      ['avec une catégorie qui n\'est pas du texte', { question: 'Q ?', answer: 'R.', category: 3 }],
      ['avec un ordre qui n\'est pas un nombre', { question: 'Q ?', answer: 'R.', order: 'premier' }],
      ['avec une publication qui n\'est pas un booléen', { question: 'Q ?', answer: 'R.', isPublished: 'oui' }]
    ])('refuse (400) une création %s', async (_label, body) => {
      const res = await request(app).post('/api/faqs/admin').set('Authorization', await asAdmin()).send(body);

      expect(res.status).toBe(400);
      expect(await Faq.countDocuments()).toBe(0);
    });

    it('met à jour les seuls champs fournis', async () => {
      const faq = await aFaq({ category: 'vente' });

      const res = await request(app)
        .put(`/api/faqs/admin/${faq._id}`)
        .set('Authorization', await asAdmin())
        .send({ answer: 'Nouvelle réponse', isPublished: false });

      expect(res.status).toBe(200);
      expect(res.body.faq).toMatchObject({ question: 'Comment vendre ?', answer: 'Nouvelle réponse', category: 'vente', isPublished: false });
    });

    it('refuse (400) une question vidée', async () => {
      const faq = await aFaq();

      const res = await request(app)
        .put(`/api/faqs/admin/${faq._id}`)
        .set('Authorization', await asAdmin())
        .send({ question: '   ' });

      expect(res.status).toBe(400);
      expect((await Faq.findById(faq._id).lean())?.question).toBe('Comment vendre ?');
    });

    it('répond 404 en mise à jour ou suppression d\'une FAQ inexistante', async () => {
      const authorization = await asAdmin();

      const updated = await request(app)
        .put('/api/faqs/admin/507f1f77bcf86cd799439011')
        .set('Authorization', authorization)
        .send({ answer: 'R.' });
      const deleted = await request(app).delete('/api/faqs/admin/507f1f77bcf86cd799439011').set('Authorization', authorization);

      expect(updated.status).toBe(404);
      expect(deleted.status).toBe(404);
      expect(deleted.body).toMatchObject({ message: 'FAQ introuvable', code: 'NOT_FOUND' });
    });

    it('supprime une FAQ', async () => {
      const faq = await aFaq();

      const res = await request(app).delete(`/api/faqs/admin/${faq._id}`).set('Authorization', await asAdmin());

      expect(res.status).toBe(200);
      expect(await Faq.exists({ _id: faq._id })).toBeNull();
    });
  });
});
