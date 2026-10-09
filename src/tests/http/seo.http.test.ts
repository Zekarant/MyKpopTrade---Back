import request from 'supertest';
import { createApp } from '../../app';
import { startInMemoryMongo, stopInMemoryMongo, clearAllCollections } from '../helpers/mongoMemory';
import { createTestUser, createTestProduct } from '../helpers/fixtures';
import KpopGroup from '../../models/kpopGroupModel';
import KpopAlbum from '../../models/albumModel';

/** Sitemap et robots.txt : n'annoncer aux moteurs que des pages qui existent côté front. */
const app = createApp();

describe('HTTP — SEO', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 60000);

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  beforeEach(async () => {
    await clearAllCollections();
  });

  describe('GET /sitemap.xml', () => {
    it('liste les annonces en vente, pas les annonces retirées', async () => {
      const seller = await createTestUser();
      const listed = await createTestProduct(seller._id);
      const withdrawn = await createTestProduct(seller._id, { isAvailable: false });

      const res = await request(app).get('/sitemap.xml');

      expect(res.status).toBe(200);
      expect(res.text).toContain(`/products/${listed._id}</loc>`);
      expect(res.text).not.toContain(String(withdrawn._id));
    });

    it('liste les pages des groupes actifs et de leurs albums, pas celles des groupes désactivés', async () => {
      const [active, inactive] = await KpopGroup.create([
        { name: 'BTS', isActive: true },
        { name: 'Groupe dissous', isActive: false }
      ]);
      const [album, hiddenAlbum] = await KpopAlbum.create([
        { name: 'BE', artistId: active._id, artistName: active.name },
        { name: 'Dernier album', artistId: inactive._id, artistName: inactive.name }
      ]);

      const res = await request(app).get('/sitemap.xml');

      expect(res.text).toContain(`/groups/${active._id}</loc>`);
      expect(res.text).toContain(`/albums/${album._id}</loc>`);
      expect(res.text).not.toContain(String(inactive._id));
      expect(res.text).not.toContain(String(hiddenAlbum._id));
    });
  });

  describe('GET /robots.txt', () => {
    it('bloque les pages privées du front sous leurs vrais chemins', async () => {
      const res = await request(app).get('/robots.txt');

      expect(res.status).toBe(200);
      for (const path of [
        '/adherents/admin',
        '/adherents/payments',
        '/adherents/messages',
        '/adherents/settings',
        '/cart',
        '/disputes',
        '/negotiate',
        '/api/'
      ]) {
        expect(res.text).toContain(`Disallow: ${path}\n`);
      }
      expect(res.text).not.toMatch(/Disallow: \/(admin|payments|messages)\n/);
    });
  });
});
