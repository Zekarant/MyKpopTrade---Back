import request from 'supertest';
import { createApp } from '../../app';
import { startInMemoryMongo, stopInMemoryMongo, clearAllCollections } from '../helpers/mongoMemory';
import { createTestUser, createTestProduct } from '../helpers/fixtures';
import KpopGroup from '../../models/kpopGroupModel';

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
    it('liste les annonces en vente, pas les annonces retirées ni les groupes (sans page front)', async () => {
      const seller = await createTestUser();
      const listed = await createTestProduct(seller._id);
      const withdrawn = await createTestProduct(seller._id, { isAvailable: false });
      const group = await KpopGroup.create({ name: 'BTS', isActive: true });

      const res = await request(app).get('/sitemap.xml');

      expect(res.status).toBe(200);
      expect(res.text).toContain(`/products/${listed._id}</loc>`);
      expect(res.text).not.toContain(String(withdrawn._id));
      expect(res.text).not.toContain('/groups/');
      expect(res.text).not.toContain(String(group._id));
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
