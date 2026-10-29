import request from 'supertest';
import mongoose from 'mongoose';
import { createApp } from '../../app';
import { startInMemoryMongo, stopInMemoryMongo, clearAllCollections } from '../helpers/mongoMemory';
import { createTestProduct, createTestUser } from '../helpers/fixtures';
import { generateAccessToken } from '../../commons/services/tokenService';
import User from '../../models/userModel';
import AuditLog from '../../models/auditLogModel';
import Post from '../../models/postModel';

/** Administration des membres : liste, statistiques, recherche, export, notes, sanctions, RGPD. */
const app = createApp();

type TestUser = Awaited<ReturnType<typeof createTestUser>>;

describe('HTTP — administration des membres', () => {
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
  const asAdmin = async () => createTestUser({ role: 'admin' });

  it('réserve les routes admin aux administrateurs', async () => {
    const member = await createTestUser();

    const res = await request(app).get('/api/users/admin/stats').set('Authorization', auth(member));

    expect(res.status).toBe(403);
  });

  describe('liste et export', () => {
    it('pagine la liste avec le format unifié et filtre par recherche', async () => {
      const admin = await asAdmin();
      await createTestUser({ username: 'jimin_fan' });
      await createTestUser({ username: 'jimin_lover' });
      await createTestUser({ username: 'autre' });

      const res = await request(app)
        .get('/api/users/admin/list?search=jimin&limit=1')
        .set('Authorization', auth(admin));

      expect(res.status).toBe(200);
      expect(res.body.users).toHaveLength(1);
      expect(res.body.pagination).toEqual({ page: 1, limit: 1, total: 2, pages: 2 });
    });

    it('ignore un rôle inconnu et filtre par statut', async () => {
      const admin = await asAdmin();
      await createTestUser({ accountStatus: 'suspended' });

      const res = await request(app)
        .get('/api/users/admin/list?status=suspended&role=superuser')
        .set('Authorization', auth(admin));

      expect(res.body.users).toHaveLength(1);
      expect(res.body.users[0].accountStatus).toBe('suspended');
    });

    it('exporte la liste en CSV, protégée contre l\'injection de formules', async () => {
      const admin = await asAdmin();
      await createTestUser({ username: 'csv_user', email: 'csv_user@test.com' });

      const res = await request(app)
        .get('/api/users/admin/list?format=csv&search=csv_user')
        .set('Authorization', auth(admin));

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toMatch(/attachment; filename="utilisateurs-\d{4}-\d{2}-\d{2}\.csv"/);
      expect(res.text).toContain('"Pseudo","Email"');
      expect(res.text).toContain('"csv_user","csv_user@test.com"');
    });
  });

  it('compte les membres par statut et les nouveaux inscrits', async () => {
    const admin = await asAdmin();
    await createTestUser({ accountStatus: 'suspended' });

    const res = await request(app).get('/api/users/admin/stats').set('Authorization', auth(admin));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ totalUsers: 2, activeUsers: 1, suspendedUsers: 1, newUsers: 2 });
  });

  it('renvoie une série quotidienne de 30 jours', async () => {
    const admin = await asAdmin();

    const res = await request(app).get('/api/users/admin/stats/timeseries').set('Authorization', auth(admin));

    expect(res.status).toBe(200);
    expect(res.body.days).toBe(30);
    expect(res.body.series).toHaveLength(30);
    expect(res.body.series[29].signups).toBe(1);
  });

  it('liste les demandes de suppression dans la file de travail', async () => {
    const admin = await asAdmin();
    await createTestUser({ scheduledForDeletion: true, scheduledDeletionDate: new Date(Date.now() + 86400e3) });

    const res = await request(app).get('/api/users/admin/queue').set('Authorization', auth(admin));

    expect(res.status).toBe(200);
    expect(res.body.counts.deletion).toBe(1);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0]).toMatchObject({ kind: 'deletion', tab: 'rgpd' });
  });

  describe('recherche globale', () => {
    it('trouve membres, annonces et publications', async () => {
      const admin = await asAdmin();
      const seller = await createTestUser({ username: 'twice_seller' });
      await createTestProduct(seller._id, { title: 'Album Twice signé' });
      await Post.create({ author: seller._id, content: 'Qui vend du Twice ?' });

      const res = await request(app).get('/api/users/admin/search?q=twice').set('Authorization', auth(admin));

      expect(res.status).toBe(200);
      expect(res.body.results.map((r: { kind: string }) => r.kind).sort()).toEqual(['post', 'product', 'user']);
    });

    it('ne cherche pas en dessous de deux caractères', async () => {
      const admin = await asAdmin();

      const res = await request(app).get('/api/users/admin/search?q=a').set('Authorization', auth(admin));

      expect(res.body).toEqual({ results: [] });
    });
  });

  describe('fiche et notes internes', () => {
    it('affiche la fiche avec les compteurs d\'activité', async () => {
      const admin = await asAdmin();
      const member = await createTestUser();
      await createTestProduct(member._id);

      const res = await request(app).get(`/api/users/admin/${member._id}/detail`).set('Authorization', auth(admin));

      expect(res.status).toBe(200);
      expect(res.body.user.username).toBe(member.username);
      expect(res.body.activity).toEqual({ listings: 1, reportsAgainst: 0, reportsFiled: 0, disputes: 0 });
    });

    it('répond 400 pour un identifiant invalide et 404 pour un membre inconnu', async () => {
      const admin = await asAdmin();

      const invalid = await request(app).get('/api/users/admin/pas-un-id/detail').set('Authorization', auth(admin));
      const unknown = await request(app)
        .get(`/api/users/admin/${new mongoose.Types.ObjectId()}/detail`)
        .set('Authorization', auth(admin));

      expect(invalid.status).toBe(400);
      expect(unknown.status).toBe(404);
      expect(unknown.body.code).toBe('USER_NOT_FOUND');
    });

    it('ajoute puis supprime une note, avec trace d\'audit', async () => {
      const admin = await asAdmin();
      const member = await createTestUser();

      const added = await request(app)
        .post(`/api/users/admin/${member._id}/notes`)
        .set('Authorization', auth(admin))
        .send({ content: '  Vendeur à surveiller  ' });

      expect(added.status).toBe(201);
      expect(added.body.adminNotes).toHaveLength(1);
      expect(added.body.adminNotes[0]).toMatchObject({ content: 'Vendeur à surveiller', author: { username: admin.username } });

      const removed = await request(app)
        .delete(`/api/users/admin/${member._id}/notes/${added.body.adminNotes[0]._id}`)
        .set('Authorization', auth(admin));

      expect(removed.status).toBe(200);
      expect(removed.body.adminNotes).toEqual([]);
      expect(await AuditLog.countDocuments({ action: { $in: ['add_user_note', 'delete_user_note'] } })).toBe(2);
    });

    it('refuse une note vide', async () => {
      const admin = await asAdmin();
      const member = await createTestUser();

      const res = await request(app)
        .post(`/api/users/admin/${member._id}/notes`)
        .set('Authorization', auth(admin))
        .send({ content: '   ' });

      expect(res.status).toBe(400);
      expect(res.body.message).toBe('Le contenu de la note est obligatoire');
    });
  });

  describe('sanctions et rôle', () => {
    const setStatus = (admin: TestUser, target: TestUser, body: Record<string, unknown>) =>
      request(app).put(`/api/users/admin/${target._id}/status`).set('Authorization', auth(admin)).send(body);

    it('suspend un membre pour une durée donnée puis le réactive', async () => {
      const admin = await asAdmin();
      const member = await createTestUser();

      const suspended = await setStatus(admin, member, { accountStatus: 'suspended', reason: 'Arnaques répétées', durationDays: 7 });

      expect(suspended.status).toBe(200);
      expect(suspended.body.user).toMatchObject({ accountStatus: 'suspended', suspension: { reason: 'Arnaques répétées' } });
      expect(suspended.body.user.suspension.until).toBeDefined();

      const reactivated = await setStatus(admin, member, { accountStatus: 'active' });

      expect(reactivated.status).toBe(200);
      expect(reactivated.body.message).toBe('Utilisateur réactivé avec succès');
      const stored = await User.findById(member._id);
      expect(stored?.accountStatus).toBe('active');
      expect(stored?.sanctions?.map((s) => s.action)).toEqual(['suspend', 'unsuspend']);
    });

    it('refuse un statut inconnu, un motif trop court ou une durée hors liste', async () => {
      const admin = await asAdmin();
      const member = await createTestUser();

      const badStatus = await setStatus(admin, member, { accountStatus: 'banned' });
      const shortReason = await setStatus(admin, member, { accountStatus: 'suspended', reason: 'non' });
      const badDuration = await setStatus(admin, member, { accountStatus: 'suspended', reason: 'Motif valable', durationDays: 3 });

      expect([badStatus.status, shortReason.status, badDuration.status]).toEqual([400, 400, 400]);
      expect((await User.findById(member._id))?.accountStatus).toBe('active');
    });

    it('protège les administrateurs (403 ADMIN_PROTECTED)', async () => {
      const admin = await asAdmin();
      const otherAdmin = await asAdmin();

      const res = await setStatus(admin, otherAdmin, { accountStatus: 'suspended', reason: 'Motif valable' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('ADMIN_PROTECTED');
    });

    it('change le rôle et refuse un rôle inconnu', async () => {
      const admin = await asAdmin();
      const member = await createTestUser();

      const ok = await request(app)
        .put(`/api/users/admin/${member._id}/role`)
        .set('Authorization', auth(admin))
        .send({ role: 'moderator' });
      const bad = await request(app)
        .put(`/api/users/admin/${member._id}/role`)
        .set('Authorization', auth(admin))
        .send({ role: 'god' });

      expect(ok.status).toBe(200);
      expect(ok.body.user).toMatchObject({ username: member.username, role: 'moderator' });
      expect(bad.status).toBe(400);
    });
  });

  describe('RGPD', () => {
    it('exporte les données d\'un membre désigné exactement, sans secrets ni notes', async () => {
      const admin = await asAdmin();
      const member = await createTestUser({ username: 'exact_name' });
      await createTestProduct(member._id);

      const res = await request(app)
        .get('/api/users/admin/export-data?search=EXACT_NAME')
        .set('Authorization', auth(admin));

      expect(res.status).toBe(200);
      expect(res.body.user.username).toBe('exact_name');
      expect(res.body.user.password).toBeUndefined();
      expect(res.body.user.adminNotes).toBeUndefined();
      expect(res.body.products).toHaveLength(1);
    });

    it('n\'interprète pas la recherche comme un motif', async () => {
      const admin = await asAdmin();
      await createTestUser();

      const res = await request(app).get('/api/users/admin/export-data?search=.*').set('Authorization', auth(admin));
      const missing = await request(app).get('/api/users/admin/export-data').set('Authorization', auth(admin));

      expect(res.status).toBe(404);
      expect(missing.status).toBe(400);
    });

    it('anonymise un membre mais jamais un administrateur', async () => {
      const admin = await asAdmin();
      const member = await createTestUser({ username: 'to_erase' });
      const otherAdmin = await createTestUser({ role: 'admin', username: 'other_admin' });

      const ok = await request(app).post('/api/users/admin/anonymize').set('Authorization', auth(admin)).send({ search: 'to_erase' });
      const refused = await request(app)
        .post('/api/users/admin/anonymize')
        .set('Authorization', auth(admin))
        .send({ search: otherAdmin.username });

      expect(ok.status).toBe(200);
      expect((await User.findById(member._id))?.username).not.toBe('to_erase');
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe('ADMIN_PROTECTED');
    });

    it('liste puis annule une demande de suppression', async () => {
      const admin = await asAdmin();
      const member = await createTestUser({ scheduledForDeletion: true, scheduledDeletionDate: new Date(Date.now() + 86400e3) });

      const list = await request(app).get('/api/users/admin/deletion-requests').set('Authorization', auth(admin));
      const cancel = await request(app).post(`/api/users/admin/${member._id}/cancel-deletion`).set('Authorization', auth(admin));

      expect(list.body.users.map((u: { username: string }) => u.username)).toEqual([member.username]);
      expect(cancel.status).toBe(200);
      const stored = await User.findById(member._id);
      expect(stored?.scheduledForDeletion).toBe(false);
      expect(stored?.scheduledDeletionDate).toBeUndefined();
    });

    it('confirme une suppression : le compte est anonymisé', async () => {
      const admin = await asAdmin();
      const member = await createTestUser({ username: 'leaving', scheduledForDeletion: true });

      const res = await request(app).post(`/api/users/admin/${member._id}/confirm-deletion`).set('Authorization', auth(admin));
      const unknown = await request(app)
        .post(`/api/users/admin/${new mongoose.Types.ObjectId()}/confirm-deletion`)
        .set('Authorization', auth(admin));

      expect(res.status).toBe(200);
      expect((await User.findById(member._id))?.username).not.toBe('leaving');
      expect(unknown.status).toBe(404);
    });

    it('compte les consentements', async () => {
      const admin = await asAdmin();
      await createTestUser({ privacyPolicyAccepted: true, marketingConsent: true });

      const res = await request(app).get('/api/users/admin/rgpd-stats').set('Authorization', auth(admin));

      expect(res.body).toEqual({ privacyAccepted: 1, dataProcessing: 0, marketing: 1 });
    });
  });
});
