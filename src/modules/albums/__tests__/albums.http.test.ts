import request from 'supertest';
import { createApp } from '../../../app';
import { startInMemoryMongo, stopInMemoryMongo, clearAllCollections } from '../../../tests/helpers/mongoMemory';
import { createTestUser } from '../../../tests/helpers/fixtures';
import { generateAccessToken } from '../../../commons/services/tokenService';
import KpopGroup from '../../../models/kpopGroupModel';
import Album from '../../../models/albumModel';

/** Contrat admin des albums, tel qu'envoyé par le panneau K-pop (artistId / albumType). */
const app = createApp();

describe('HTTP — albums (admin)', () => {
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

  it('crée un album à partir du payload du panneau admin', async () => {
    const group = await KpopGroup.create({ name: 'NewJeans' });

    const res = await request(app)
      .post('/api/albums')
      .set('Authorization', await adminAuth())
      .send({
        name: 'Get Up',
        artistId: String(group._id),
        albumType: 'ep',
        releaseDate: '2023-07-21',
        coverImage: 'https://example.com/get-up.jpg'
      });

    expect(res.status).toBe(201);
    expect(res.body.album).toMatchObject({
      name: 'Get Up',
      artistName: 'NewJeans',
      albumType: 'ep',
      coverImage: 'https://example.com/get-up.jpg'
    });
    expect(res.body.album.artistId).toMatchObject({ _id: String(group._id), name: 'NewJeans' });
  });

  it('crée un album avec seulement le nom et le groupe', async () => {
    const group = await KpopGroup.create({ name: 'IVE' });

    const res = await request(app)
      .post('/api/albums')
      .set('Authorization', await adminAuth())
      .send({ name: 'I\'ve IVE', artistId: String(group._id) });

    expect(res.status).toBe(201);
    const stored = await Album.findOne().lean();
    expect(stored).toMatchObject({ name: 'I\'ve IVE', artistName: 'IVE', discoverySource: 'Manual' });
    expect(stored?.totalTracks).toBeUndefined();
  });

  it('conserve un nombre de pistes fourni', async () => {
    const group = await KpopGroup.create({ name: 'TWICE' });

    const res = await request(app)
      .post('/api/albums')
      .set('Authorization', await adminAuth())
      .send({ name: 'Formula of Love', artistId: String(group._id), totalTracks: 17 });

    expect(res.status).toBe(201);
    expect(res.body.album.totalTracks).toBe(17);
  });

  it('refuse l\'ancien payload `group`/`type` par un 400 « Groupe non trouvé »', async () => {
    const group = await KpopGroup.create({ name: 'aespa' });

    const res = await request(app)
      .post('/api/albums')
      .set('Authorization', await adminAuth())
      .send({ name: 'Armageddon', group: String(group._id), type: 'full' });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Groupe non trouvé');
  });

  it('répond 400, pas 500, à une donnée invalide', async () => {
    const group = await KpopGroup.create({ name: 'BABYMONSTER' });

    const res = await request(app)
      .post('/api/albums')
      .set('Authorization', await adminAuth())
      .send({ name: 'Drip', artistId: String(group._id), albumType: 'mixtape' });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('albumType');
  });

  it('ignore les champs techniques envoyés par le client', async () => {
    const group = await KpopGroup.create({ name: 'KISS OF LIFE' });

    const res = await request(app)
      .post('/api/albums')
      .set('Authorization', await adminAuth())
      .send({ name: 'Lose Yourself', artistId: String(group._id), artistName: 'Autre', discoverySource: 'Spotify' });

    expect(res.status).toBe(201);
    expect(res.body.album).toMatchObject({ artistName: 'KISS OF LIFE', discoverySource: 'Manual' });
  });

  it('met à jour le groupe et le type d\'un album', async () => {
    const [before, after] = await KpopGroup.create([{ name: 'LE SSERAFIM' }, { name: 'ILLIT' }]);
    const album = await Album.create({
      name: 'Easy',
      artistId: before._id,
      artistName: before.name,
      totalTracks: 5
    });

    const res = await request(app)
      .put(`/api/albums/${album._id}`)
      .set('Authorization', await adminAuth())
      .send({ name: 'Easy', artistId: String(after._id), albumType: 'single', releaseDate: '2024-02-19' });

    expect(res.status).toBe(200);
    expect(res.body.album).toMatchObject({ artistName: 'ILLIT', albumType: 'single' });
    expect(res.body.album.artistId).toMatchObject({ _id: String(after._id) });
  });
});
