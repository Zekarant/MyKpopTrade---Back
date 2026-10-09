import request from 'supertest';
import { createApp } from '../../app';
import { startInMemoryMongo, stopInMemoryMongo, clearAllCollections } from '../helpers/mongoMemory';
import { createTestUser } from '../helpers/fixtures';
import { generateAccessToken } from '../../commons/services/tokenService';
import User from '../../models/userModel';
import Report from '../../models/reportModel';
import Conversation from '../../models/conversationModel';
import Message from '../../models/messageModel';

/** Signalements : entrées refusées proprement, doublons et inondation bloqués. */
const app = createApp();

describe('HTTP — signalements', () => {
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
  const report = (reporter: Awaited<ReturnType<typeof createTestUser>>, body: Record<string, unknown>) =>
    request(app).post('/api/reports').set('Authorization', auth(reporter)).send(body);

  it('crée un signalement valide', async () => {
    const reporter = await createTestUser();
    const target = await createTestUser();

    const res = await report(reporter, { targetType: 'user', targetId: String(target._id), reason: 'spam' });

    expect(res.status).toBe(201);
  });

  it('refuse un motif inconnu ou des détails trop longs par un 400, pas un 500', async () => {
    const reporter = await createTestUser();
    const target = await createTestUser();

    const badReason = await report(reporter, { targetType: 'user', targetId: String(target._id), reason: 'pas-un-motif' });
    const longDetails = await report(reporter, {
      targetType: 'user', targetId: String(target._id), reason: 'spam', details: 'x'.repeat(501)
    });

    expect(badReason.status).toBe(400);
    expect(longDetails.status).toBe(400);
    expect(await Report.countDocuments()).toBe(0);
  });

  it('refuse un second signalement, même envoyé en même temps', async () => {
    const reporter = await createTestUser();
    const target = await createTestUser();
    const body = { targetType: 'user', targetId: String(target._id), reason: 'spam' };

    const responses = await Promise.all([report(reporter, body), report(reporter, body)]);

    expect(responses.map((r) => r.status).sort()).toEqual([201, 400]);
    expect(await Report.countDocuments()).toBe(1);
  });

  it('limite le nombre de signalements par compte', async () => {
    const reporter = await createTestUser();
    const targets = await User.insertMany(
      Array.from({ length: 21 }, (_, i) => ({ username: `cible_${i}`, email: `cible_${i}@test.com`, password: 'Password1!' }))
    );

    const statuses: number[] = [];
    for (const target of targets) {
      statuses.push((await report(reporter, { targetType: 'user', targetId: String(target._id), reason: 'spam' })).status);
    }

    expect(statuses.filter((s) => s === 201)).toHaveLength(20);
    expect(statuses[20]).toBe(429);
  });

  it('plafonne la taille de page de ses signalements', async () => {
    const reporter = await createTestUser();

    const res = await request(app).get('/api/reports/me?limit=100000').set('Authorization', auth(reporter));

    expect(res.body.pagination.limit).toBe(50);
  });

  it('compte l\'historique du signaleur par statut dans le détail admin', async () => {
    const admin = await createTestUser({ role: 'admin' });
    const reporter = await createTestUser();
    const [first, second, third] = await User.insertMany(
      Array.from({ length: 3 }, (_, i) => ({ username: `cible_${i}`, email: `cible_${i}@test.com`, password: 'Password1!' }))
    );
    const base = { reporter: reporter._id, targetType: 'user', reason: 'spam' };
    const [pending] = await Report.insertMany([
      { ...base, targetId: first._id, status: 'pending' },
      { ...base, targetId: second._id, status: 'resolved' },
      { ...base, targetId: third._id, status: 'resolved' }
    ]);

    const res = await request(app).get(`/api/reports/${pending._id}`).set('Authorization', auth(admin));

    expect(res.status).toBe(200);
    expect(res.body.reporterHistory).toEqual({ total: 3, resolved: 2, rejected: 0, pending: 1 });
    expect(res.body.targetHistory).toEqual({ totalReports: 1 });
  });

  describe('messages privés', () => {
    /** Conversation entre alice et bob, avec un message d'alice. */
    async function seedMessage() {
      const alice = await createTestUser();
      const bob = await createTestUser();
      const conversation = await Conversation.create({ participants: [alice._id, bob._id], createdBy: alice._id });
      const message = await Message.create({ conversation: conversation._id, sender: alice._id, content: 'Paie-moi hors site' });
      return { alice, bob, message };
    }

    it('laisse l\'autre participant signaler un message et en garde le texte', async () => {
      const { bob, message } = await seedMessage();

      const res = await report(bob, { targetType: 'message', targetId: String(message._id), reason: 'fraud' });

      expect(res.status).toBe(201);
      const stored = await Report.findOne({ targetId: message._id });
      expect(stored?.reportedContent).toBe('Paie-moi hors site');
    });

    it('refuse le signalement d\'un message par un non-participant (403)', async () => {
      const { message } = await seedMessage();
      const outsider = await createTestUser();

      const res = await report(outsider, { targetType: 'message', targetId: String(message._id), reason: 'spam' });

      expect(res.status).toBe(403);
      expect(await Report.countDocuments()).toBe(0);
    });

    it('refuse de signaler son propre message (400)', async () => {
      const { alice, message } = await seedMessage();

      const res = await report(alice, { targetType: 'message', targetId: String(message._id), reason: 'spam' });

      expect(res.status).toBe(400);
    });

    it('montre à l\'admin le texte du message signalé, même supprimé depuis', async () => {
      const admin = await createTestUser({ role: 'admin' });
      const { alice, bob, message } = await seedMessage();
      const created = await report(bob, { targetType: 'message', targetId: String(message._id), reason: 'fraud' });
      await Message.updateOne({ _id: message._id }, { isDeleted: true, content: '[Message supprimé]' });

      const res = await request(app).get(`/api/reports/${created.body.report.id}`).set('Authorization', auth(admin));

      expect(res.status).toBe(200);
      expect(res.body.target).toMatchObject({ type: 'message', meta: { isDeleted: true } });
      expect(res.body.target.owner.username).toBe(alice.username);
      expect(res.body.report.reportedContent).toBe('Paie-moi hors site');
    });
  });

  it('liste mes signalements avec leur statut, et seulement les miens', async () => {
    const reporter = await createTestUser();
    const other = await createTestUser();
    const target = await createTestUser();
    await Report.create([
      { reporter: reporter._id, targetType: 'user', targetId: target._id, reason: 'spam', status: 'resolved' },
      { reporter: other._id, targetType: 'user', targetId: target._id, reason: 'spam' }
    ]);

    const res = await request(app).get('/api/reports/me').set('Authorization', auth(reporter));

    expect(res.status).toBe(200);
    expect(res.body.reports).toHaveLength(1);
    expect(res.body.reports[0]).toMatchObject({ targetType: 'user', status: 'resolved' });
  });

  it('répond 404, pas 500, pour un identifiant de signalement invalide', async () => {
    const admin = await createTestUser({ role: 'admin' });

    const res = await request(app)
      .put('/api/reports/pas-un-id')
      .set('Authorization', auth(admin))
      .send({ status: 'resolved' });

    expect(res.status).toBe(404);
  });
});
