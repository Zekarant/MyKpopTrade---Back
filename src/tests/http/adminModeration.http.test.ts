import request from 'supertest';
import mongoose from 'mongoose';
import { createApp } from '../../app';
import { startInMemoryMongo, stopInMemoryMongo, clearAllCollections } from '../helpers/mongoMemory';
import { createTestUser } from '../helpers/fixtures';
import { generateAccessToken } from '../../commons/services/tokenService';
import Post from '../../models/postModel';
import AuditLog from '../../models/auditLogModel';

/** Modération admin des publications et journal d'audit. */
const app = createApp();

type TestUser = Awaited<ReturnType<typeof createTestUser>>;

describe('HTTP — modération admin', () => {
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

  async function seedThread(author: TestUser) {
    const parent = await Post.create({ author: author._id, content: 'Échange photocards BTS', repliesCount: 1 });
    const reply = await Post.create({ author: author._id, content: 'Toujours dispo ?', isReply: true, parentPost: parent._id });
    return { parent, reply };
  }

  it('liste les publications filtrées par type avec la pagination unifiée', async () => {
    const admin = await createTestUser({ role: 'admin' });
    await seedThread(admin);

    const res = await request(app).get('/api/users/admin/posts?type=reply').set('Authorization', auth(admin));

    expect(res.status).toBe(200);
    expect(res.body.posts).toHaveLength(1);
    expect(res.body.posts[0].author.username).toBe(admin.username);
    expect(res.body.pagination).toEqual({ page: 1, limit: 20, total: 1, pages: 1 });
  });

  it('compte publications, réponses et publications du jour', async () => {
    const admin = await createTestUser({ role: 'admin' });
    await seedThread(admin);

    const res = await request(app).get('/api/users/admin/posts/stats').set('Authorization', auth(admin));

    expect(res.body).toEqual({ totalPosts: 1, totalReplies: 1, todayPosts: 1 });
  });

  it('supprime une publication avec ses réponses et journalise l\'action', async () => {
    const admin = await createTestUser({ role: 'admin' });
    const { parent } = await seedThread(admin);

    const res = await request(app)
      .delete(`/api/users/admin/posts/${parent._id}`)
      .set('Authorization', auth(admin))
      .send({ reason: 'Spam' });

    expect(res.status).toBe(200);
    expect(await Post.countDocuments()).toBe(0);
    const log = await AuditLog.findOne({ action: 'delete_post' });
    expect(log?.details).toBe('Spam');
  });

  it('supprime une réponse sans corps de requête et décrémente le compteur du parent', async () => {
    const admin = await createTestUser({ role: 'admin' });
    const { parent, reply } = await seedThread(admin);

    const res = await request(app).delete(`/api/users/admin/posts/${reply._id}`).set('Authorization', auth(admin));

    expect(res.status).toBe(200);
    expect((await Post.findById(parent._id))?.repliesCount).toBe(0);
    expect((await AuditLog.findOne({ action: 'delete_post' }))?.details).toBe('Suppression par modération');
  });

  it('répond 404 pour une publication inconnue', async () => {
    const admin = await createTestUser({ role: 'admin' });

    const res = await request(app)
      .delete(`/api/users/admin/posts/${new mongoose.Types.ObjectId()}`)
      .set('Authorization', auth(admin));

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ message: 'Post introuvable', code: 'NOT_FOUND' });
  });

  it('liste le journal d\'audit filtré et paginé, et en donne les statistiques', async () => {
    const admin = await createTestUser({ role: 'admin' });
    await AuditLog.create([
      { admin: admin._id, action: 'delete_post', targetType: 'post' },
      { admin: admin._id, action: 'suspend_user', targetType: 'user' },
      { admin: admin._id, action: 'change_role', targetType: 'user' }
    ]);

    const logs = await request(app).get('/api/users/admin/audit?targetType=user&limit=1').set('Authorization', auth(admin));
    const stats = await request(app).get('/api/users/admin/audit/stats').set('Authorization', auth(admin));

    expect(logs.status).toBe(200);
    expect(logs.body.logs).toHaveLength(1);
    expect(logs.body.logs[0].admin.username).toBe(admin.username);
    expect(logs.body.pagination).toEqual({ page: 1, limit: 1, total: 2, pages: 2 });
    expect(stats.body).toEqual({ todayActions: 3, weekActions: 3, byType: { post: 1, user: 2 } });
  });
});
