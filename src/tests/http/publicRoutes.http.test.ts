import request from 'supertest';
import { createApp } from '../../app';
import {
  startInMemoryMongo,
  stopInMemoryMongo,
  clearAllCollections
} from '../helpers/mongoMemory';
import { createTestUser } from '../helpers/fixtures';
import KpopGroup from '../../models/kpopGroupModel';
import Album from '../../models/albumModel';

const app = createApp();

describe('HTTP — routes publiques (via supertest)', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 60000);

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  beforeEach(async () => {
    await clearAllCollections();
  });

  describe('GET /', () => {
    it('retourne 200 avec le texte de version', async () => {
      const res = await request(app).get('/');
      expect(res.status).toBe(200);
      expect(res.text).toContain('MyKpopTrade');
    });
  });

  describe('GET /api/groups/search', () => {
    it('retourne 400 sans paramètre query', async () => {
      const res = await request(app).get('/api/groups/search');
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/recherche/i);
    });

    it('retourne 200 avec les groupes correspondants', async () => {
      await KpopGroup.create({ name: 'BTS', isActive: true });
      await KpopGroup.create({ name: 'BLACKPINK', isActive: true });

      const res = await request(app).get('/api/groups/search?query=BTS');
      expect(res.status).toBe(200);
      expect(res.body.groups).toHaveLength(1);
      expect(res.body.groups[0].name).toBe('BTS');
      expect(res.body.found).toBe(1);
    });

    it('exclut les groupes inactifs par défaut', async () => {
      await KpopGroup.create({ name: 'ActiveGroup', isActive: true });
      await KpopGroup.create({ name: 'ActiveGroup2', isActive: false });

      const res = await request(app).get('/api/groups/search?query=Active');
      expect(res.status).toBe(200);
      expect(res.body.groups).toHaveLength(1);
    });

    it('inclut les inactifs avec includeInactive=true', async () => {
      await KpopGroup.create({ name: 'Group_A', isActive: true });
      await KpopGroup.create({ name: 'Group_B', isActive: false });

      const res = await request(app).get(
        '/api/groups/search?query=Group&includeInactive=true'
      );
      expect(res.status).toBe(200);
      expect(res.body.groups).toHaveLength(2);
    });
  });

  describe('GET /api/groups/:groupId', () => {
    it('retourne 400 pour un ID invalide', async () => {
      const res = await request(app).get('/api/groups/not-an-id');
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/invalide/i);
    });

    it('retourne 404 pour un ID bien formé mais inexistant', async () => {
      const res = await request(app).get('/api/groups/507f1f77bcf86cd799439011');
      expect(res.status).toBe(404);
    });

    it('retourne 200 avec groupe + albums + stats', async () => {
      const group = await KpopGroup.create({ name: 'TWICE', isActive: true });
      await Album.create({
        name: 'FANCY YOU',
        artistId: group._id,
        artistName: 'TWICE',
        totalTracks: 7,
        releaseDate: new Date('2019-04-22')
      });

      // Petit délai pour laisser mongo aggregate se settle
      await new Promise((resolve) => setTimeout(resolve, 50));

      const res = await request(app).get(`/api/groups/${group._id}`);
      expect(res.status).toBe(200);
      expect(res.body.group.name).toBe('TWICE');
      expect(res.body.albums).toHaveLength(1);
      expect(res.body.stats.totalAlbums).toBe(1);
    });
  });

  describe('GET /api/albums', () => {
    it('retourne 200 avec liste paginée', async () => {
      const group = await KpopGroup.create({ name: 'G_X', isActive: true });
      await Album.create({ name: 'A1', artistId: group._id, artistName: 'G_X', totalTracks: 5 });
      await Album.create({ name: 'A2', artistId: group._id, artistName: 'G_X', totalTracks: 3 });

      const res = await request(app).get('/api/albums?page=1&limit=10');
      expect(res.status).toBe(200);
      expect(res.body.albums).toHaveLength(2);
      expect(res.body.pagination).toMatchObject({
        page: 1,
        limit: 10,
        total: 2,
        pages: 1
      });
    });
  });

  describe('GET /api/profiles/user/:identifier', () => {
    it('retourne 404 pour un utilisateur inexistant', async () => {
      const res = await request(app).get('/api/profiles/user/507f1f77bcf86cd799439011');
      expect(res.status).toBe(404);
    });

    it('retourne 200 pour un utilisateur actif (recherche par username)', async () => {
      const user = await createTestUser();

      const res = await request(app).get(`/api/profiles/user/${user.username}`);
      expect(res.status).toBe(200);
      expect(res.body.profile.username).toBe(user.username);
    });
  });

  describe('routes non trouvées', () => {
    it('retourne 404 pour une route inconnue', async () => {
      const res = await request(app).get('/api/does-not-exist');
      expect(res.status).toBe(404);
    });
  });

  describe('auth requise', () => {
    it('GET /api/users/me/data-export sans token → 401', async () => {
      const res = await request(app).get('/api/users/me/data-export');
      expect(res.status).toBe(401);
    });

    it('POST /api/products sans token → 401', async () => {
      const res = await request(app).post('/api/products').send({ title: 'x' });
      expect(res.status).toBe(401);
    });
  });
});
