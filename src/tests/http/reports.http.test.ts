import request from 'supertest';
import mongoose from 'mongoose';
import { createApp } from '../../app';
import { startInMemoryMongo, stopInMemoryMongo, clearAllCollections } from '../helpers/mongoMemory';
import { createTestUser } from '../helpers/fixtures';
import { generateAccessToken } from '../../commons/services/tokenService';
import User from '../../models/userModel';
import Report from '../../models/reportModel';
import Conversation from '../../models/conversationModel';
import Message from '../../models/messageModel';
import AuditLog from '../../models/auditLogModel';

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

  it('indique l\'élément déjà signalé avec le code ALREADY_REPORTED', async () => {
    const reporter = await createTestUser();
    const target = await createTestUser();
    const body = { targetType: 'user', targetId: String(target._id), reason: 'spam' };
    const first = await report(reporter, body);

    const second = await report(reporter, body);

    expect(second.status).toBe(400);
    expect(second.body).toMatchObject({ code: 'ALREADY_REPORTED', reportId: first.body.report.id });
  });

  it('refuse de signaler son propre profil ou une cible inexistante', async () => {
    const reporter = await createTestUser();

    const self = await report(reporter, { targetType: 'user', targetId: String(reporter._id), reason: 'spam' });
    const missing = await report(reporter, { targetType: 'product', targetId: String(new mongoose.Types.ObjectId()), reason: 'spam' });
    const badType = await report(reporter, { targetType: 'album', targetId: String(reporter._id), reason: 'spam' });

    expect([self.status, missing.status, badType.status]).toEqual([400, 404, 400]);
  });

  it('dit si j\'ai déjà signalé un élément', async () => {
    const reporter = await createTestUser();
    const target = await createTestUser();
    await report(reporter, { targetType: 'user', targetId: String(target._id), reason: 'fraud' });

    const reported = await request(app).get(`/api/reports/check/user/${target._id}`).set('Authorization', auth(reporter));
    const other = await request(app).get(`/api/reports/check/user/${reporter._id}`).set('Authorization', auth(reporter));
    const invalid = await request(app).get('/api/reports/check/user/pas-un-id').set('Authorization', auth(reporter));

    expect(reported.body).toMatchObject({ hasReported: true, report: { reason: 'fraud', status: 'pending' } });
    expect(other.body).toEqual({ hasReported: false, report: null });
    expect(invalid.status).toBe(400);
  });

  describe('administration', () => {
    async function seedReports() {
      const reporter = await createTestUser();
      const [first, second] = await User.insertMany(
        Array.from({ length: 2 }, (_, i) => ({ username: `cible_${i}`, email: `cible_${i}@test.com`, password: 'Password1!' }))
      );
      return Report.insertMany([
        { reporter: reporter._id, targetType: 'user', targetId: first._id, reason: 'spam', status: 'pending' },
        { reporter: reporter._id, targetType: 'user', targetId: second._id, reason: 'fraud', status: 'resolved' }
      ]);
    }

    it('liste les signalements filtrés avec la pagination unifiée', async () => {
      const admin = await createTestUser({ role: 'admin' });
      await seedReports();

      const res = await request(app).get('/api/reports?status=pending').set('Authorization', auth(admin));

      expect(res.status).toBe(200);
      expect(res.body.reports).toHaveLength(1);
      expect(res.body.reports[0].reporter.username).toBeDefined();
      expect(res.body.pagination).toEqual({ page: 1, limit: 20, total: 1, pages: 1 });
    });

    it('refuse la liste complète à un membre', async () => {
      const member = await createTestUser();

      const res = await request(app).get('/api/reports').set('Authorization', auth(member));

      expect(res.status).toBe(403);
    });

    it('exporte les signalements en CSV avec les libellés', async () => {
      const admin = await createTestUser({ role: 'admin' });
      await seedReports();

      const res = await request(app).get('/api/reports?format=csv').set('Authorization', auth(admin));

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toMatch(/filename="signalements-\d{4}-\d{2}-\d{2}\.csv"/);
      expect(res.text).toContain('"Fraude"');
      expect(res.text.split('\r\n')).toHaveLength(3);
    });

    it('résout un signalement, avec date de résolution, notes et audit', async () => {
      const admin = await createTestUser({ role: 'admin' });
      const [pending] = await seedReports();

      const res = await request(app)
        .put(`/api/reports/${pending._id}`)
        .set('Authorization', auth(admin))
        .send({ status: 'resolved', adminNotes: 'Compte suspendu' });

      expect(res.status).toBe(200);
      expect(res.body.report).toMatchObject({ status: 'resolved', adminNotes: 'Compte suspendu' });
      expect(res.body.report.resolvedAt).toBeDefined();
      expect(await AuditLog.countDocuments({ action: 'report_resolved' })).toBe(1);
    });

    it('refuse un statut de résolution inconnu', async () => {
      const admin = await createTestUser({ role: 'admin' });
      const [pending] = await seedReports();

      const res = await request(app).put(`/api/reports/${pending._id}`).set('Authorization', auth(admin)).send({ status: 'pending' });

      expect(res.status).toBe(400);
    });

    it('traite plusieurs signalements en lot, en ignorant les identifiants invalides', async () => {
      const admin = await createTestUser({ role: 'admin' });
      const reports = await seedReports();

      const res = await request(app)
        .put('/api/reports/bulk')
        .set('Authorization', auth(admin))
        .send({ reportIds: [...reports.map((r) => String(r._id)), 'pas-un-id'], status: 'rejected' });
      const empty = await request(app).put('/api/reports/bulk').set('Authorization', auth(admin)).send({ reportIds: [], status: 'rejected' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ message: '2 signalement(s) mis à jour', updated: 2 });
      expect(await Report.countDocuments({ status: 'rejected' })).toBe(2);
      expect(empty.status).toBe(400);
    });

    it('répond 400 pour un identifiant invalide dans le détail et 404 pour un signalement inconnu', async () => {
      const admin = await createTestUser({ role: 'admin' });

      const invalid = await request(app).get('/api/reports/pas-un-id').set('Authorization', auth(admin));
      const unknown = await request(app).get(`/api/reports/${new mongoose.Types.ObjectId()}`).set('Authorization', auth(admin));

      expect(invalid.status).toBe(400);
      expect(unknown.status).toBe(404);
    });
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
