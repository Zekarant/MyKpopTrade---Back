import request from 'supertest';
import mongoose from 'mongoose';
import { createApp } from '../../app';
import { startInMemoryMongo, stopInMemoryMongo, clearAllCollections } from '../helpers/mongoMemory';
import { createTestUser } from '../helpers/fixtures';
import { generateAccessToken } from '../../commons/services/tokenService';
import Follow from '../../models/followModel';
import User from '../../models/userModel';

/** Abonnements : cibles réelles, listes sans trou, erreurs propres. */
const app = createApp();

describe('HTTP — abonnements', () => {
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

  it('suit puis ne suit plus un membre', async () => {
    const me = await createTestUser();
    const alice = await createTestUser();

    const first = await request(app).post(`/api/follows/${alice._id}/toggle`).set('Authorization', auth(me));
    const second = await request(app).post(`/api/follows/${alice._id}/toggle`).set('Authorization', auth(me));

    expect(first.body.isFollowing).toBe(true);
    expect(second.body.isFollowing).toBe(false);
  });

  it('refuse de suivre un compte inexistant ou supprimé', async () => {
    const me = await createTestUser();
    const gone = await createTestUser();
    await User.updateOne({ _id: gone._id }, { accountStatus: 'deleted' });

    const unknown = await request(app)
      .post(`/api/follows/${new mongoose.Types.ObjectId()}/toggle`)
      .set('Authorization', auth(me));
    const deleted = await request(app).post(`/api/follows/${gone._id}/toggle`).set('Authorization', auth(me));

    expect(unknown.status).toBe(404);
    expect(deleted.status).toBe(404);
    expect(await Follow.countDocuments()).toBe(0);
  });

  it('répond 404 sans détail interne pour un identifiant invalide', async () => {
    const me = await createTestUser();

    const res = await request(app).get('/api/follows/pas-un-id/followers').set('Authorization', auth(me));

    expect(res.status).toBe(404);
    expect(res.body.message).not.toMatch(/Cast/);
  });

  it('retire des listes les abonnés dont le compte a disparu', async () => {
    const me = await createTestUser();
    const alice = await createTestUser();
    await Follow.create({ follower: alice._id, following: me._id });
    await Follow.create({ follower: new mongoose.Types.ObjectId(), following: me._id });

    const res = await request(app).get(`/api/follows/${me._id}/followers`).set('Authorization', auth(me));

    expect(res.body.followers).toHaveLength(1);
    expect(res.body.followers[0].username).toBe(alice.username);
  });

  it('plafonne la taille de page demandée', async () => {
    const me = await createTestUser();
    const fans = await User.insertMany(
      Array.from({ length: 51 }, (_, i) => ({ username: `fan_${i}`, email: `fan_${i}@test.com`, password: 'Password1!' }))
    );
    await Follow.insertMany(fans.map((fan) => ({ follower: fan._id, following: me._id })));

    const res = await request(app).get(`/api/follows/${me._id}/followers?limit=100000`).set('Authorization', auth(me));

    expect(res.body.followers).toHaveLength(50);
    expect(res.body.pagination).toEqual({ page: 1, limit: 50, total: 51, pages: 2 });
  });

  it('refuse (400) de se suivre soi-même', async () => {
    const me = await createTestUser();

    const res = await request(app).post(`/api/follows/${me._id}/toggle`).set('Authorization', auth(me));

    expect(res.status).toBe(400);
  });

  it('donne le statut d\'abonnement et les compteurs d\'un membre', async () => {
    const me = await createTestUser();
    const alice = await createTestUser();
    const bob = await createTestUser();
    await Follow.create([
      { follower: me._id, following: alice._id },
      { follower: bob._id, following: alice._id },
      { follower: alice._id, following: bob._id }
    ]);

    const res = await request(app).get(`/api/follows/${alice._id}/status`).set('Authorization', auth(me));

    expect(res.body).toEqual({ isFollowing: true, followersCount: 2, followingCount: 1 });
  });

  it('liste les abonnements d\'un membre', async () => {
    const me = await createTestUser();
    const alice = await createTestUser();
    await Follow.create({ follower: me._id, following: alice._id });

    const res = await request(app).get(`/api/follows/${me._id}/following`).set('Authorization', auth(me));

    expect(res.body.following.map((user: { username: string }) => user.username)).toEqual([alice.username]);
    expect(res.body.pagination).toEqual({ page: 1, limit: 20, total: 1, pages: 1 });
  });

  it('liste comme amis les seuls abonnements réciproques', async () => {
    const me = await createTestUser();
    const friend = await createTestUser();
    const idol = await createTestUser();
    await Follow.create([
      { follower: me._id, following: friend._id },
      { follower: friend._id, following: me._id },
      { follower: me._id, following: idol._id }
    ]);

    const res = await request(app).get('/api/follows/me/friends').set('Authorization', auth(me));

    expect(res.body.friends.map((user: { username: string }) => user.username)).toEqual([friend.username]);
    expect(res.body.pagination.total).toBe(1);
  });

  it('donne mes compteurs', async () => {
    const me = await createTestUser();
    const alice = await createTestUser();
    await Follow.create({ follower: alice._id, following: me._id });

    const res = await request(app).get('/api/follows/me/counts').set('Authorization', auth(me));

    expect(res.body).toEqual({ followersCount: 1, followingCount: 0 });
  });

  it('retire un abonné, et répond 404 pour un membre qui ne me suit pas', async () => {
    const me = await createTestUser();
    const fan = await createTestUser();
    await Follow.create({ follower: fan._id, following: me._id });

    const removed = await request(app).delete(`/api/follows/me/followers/${fan._id}`).set('Authorization', auth(me));
    const again = await request(app).delete(`/api/follows/me/followers/${fan._id}`).set('Authorization', auth(me));

    expect(removed.body).toMatchObject({ message: 'Abonné retiré', removed: true });
    expect(again.status).toBe(404);
    expect(again.body.message).toBe('Cet utilisateur ne vous suit pas');
  });
});
