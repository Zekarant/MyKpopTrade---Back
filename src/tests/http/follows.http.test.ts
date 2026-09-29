import request from 'supertest';
import mongoose from 'mongoose';
import { createApp } from '../../app';
import { startInMemoryMongo, stopInMemoryMongo, clearAllCollections } from '../helpers/mongoMemory';
import { createTestUser } from '../helpers/fixtures';
import { generateAccessToken } from '../../commons/services/tokenService';
import Follow from '../../modules/follows/model';
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
    expect(res.body.totalPages).toBe(2);
  });
});
