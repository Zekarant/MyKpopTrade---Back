import request from 'supertest';
import { createApp } from '../../../app';
import { startInMemoryMongo, stopInMemoryMongo, clearAllCollections } from '../../../tests/helpers/mongoMemory';
import { createTestUser } from '../../../tests/helpers/fixtures';
import { generateAccessToken } from '../../../commons/services/tokenService';
import KpopGroup from '../../../models/kpopGroupModel';

const app = createApp();

describe('HTTP — groupes (admin)', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 60000);

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  beforeEach(async () => {
    await clearAllCollections();
  });

  const adminAuth = async () => `Bearer ${generateAccessToken(await createTestUser({ role: 'admin' }))}`;

  it('crée un groupe avec ses membres, sans accepter les compteurs du client', async () => {
    const res = await request(app)
      .post('/api/groups')
      .set('Authorization', await adminAuth())
      .send({ name: 'Stray Kids', members: ['Bang Chan', 'Felix'], followersCount: 999, discoverySource: 'Last.fm' });

    expect(res.status).toBe(201);
    const stored = await KpopGroup.findOne({ name: 'Stray Kids' }).lean();
    expect(stored?.members).toEqual(['Bang Chan', 'Felix']);
    expect(stored?.followersCount).toBe(0);
    expect(stored?.discoverySource).toBe('Manual');
  });

  it('refuse un groupe sans nom', async () => {
    const res = await request(app)
      .post('/api/groups')
      .set('Authorization', await adminAuth())
      .send({ tags: ['girl group'] });

    expect(res.status).toBe(400);
  });

  it('ne laisse pas la mise à jour toucher aux abonnés', async () => {
    const group = await KpopGroup.create({ name: 'ITZY' });
    const intruder = await createTestUser();

    const res = await request(app)
      .put(`/api/groups/${group._id}`)
      .set('Authorization', await adminAuth())
      .send({ tags: ['girl group'], followers: [String(intruder._id)], followersCount: 42 });

    expect(res.status).toBe(200);
    const stored = await KpopGroup.findById(group._id).lean();
    expect(stored?.tags).toEqual(['girl group']);
    expect(stored?.followers).toEqual([]);
    expect(stored?.followersCount).toBe(0);
  });

  it('borne la limite de la recherche publique (négative ou invalide → défaut)', async () => {
    await KpopGroup.insertMany(Array.from({ length: 25 }, (_, i) => ({ name: `Groupe ${i}`, isActive: true })));

    const negative = await request(app).get('/api/groups/search').query({ query: 'Groupe', limit: '-5' });
    const invalid = await request(app).get('/api/groups/search').query({ query: 'Groupe', limit: 'abc' });

    expect(negative.status).toBe(200);
    expect(negative.body.found).toBe(20);
    expect(invalid.body.found).toBe(20);
  });
});
