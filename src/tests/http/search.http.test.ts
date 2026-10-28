import request from 'supertest';
import { createApp } from '../../app';
import { startInMemoryMongo, stopInMemoryMongo, clearAllCollections } from '../helpers/mongoMemory';
import { createTestUser, createTestProduct } from '../helpers/fixtures';
import { generateAccessToken } from '../../commons/services/tokenService';
import KpopGroup from '../../models/kpopGroupModel';
import KpopAlbum from '../../models/albumModel';
import SearchHistory from '../../models/historicSearchModel';

/** Recherche : filtres de la recherche avancée, suggestions et historique. */
const app = createApp();

describe('HTTP — recherche', () => {
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
  const search = (body: object) => request(app).post('/api/search/advanced').send(body);
  const titlesOf = (res: request.Response) => (res.body.products as Array<{ title: string }>).map((p) => p.title).sort();

  describe('POST /api/search/advanced', () => {
    it('cherche le texte dans le titre, la description et le groupe, sans les annonces retirées', async () => {
      const seller = await createTestUser();
      await createTestProduct(seller._id, { title: 'Album Butter', kpopGroup: 'BTS' });
      await createTestProduct(seller._id, { title: 'Photocard', description: 'Version butter rare', kpopGroup: 'BTS' });
      await createTestProduct(seller._id, { title: 'Butter retiré', isAvailable: false });
      await createTestProduct(seller._id, { title: 'Autre chose', kpopGroup: 'TWICE' });

      const res = await search({ query: 'butter' });

      expect(res.status).toBe(200);
      expect(titlesOf(res)).toEqual(['Album Butter', 'Photocard']);
      expect(res.body.searchMetadata).toMatchObject({ query: 'butter', resultCount: 2 });
    });

    it('combine groupes, prix, état, type et devise', async () => {
      const seller = await createTestUser();
      await createTestProduct(seller._id, { title: 'Match', kpopGroup: 'bts', price: 15, condition: 'new', type: 'album', currency: 'EUR' });
      await createTestProduct(seller._id, { title: 'Trop cher', kpopGroup: 'BTS', price: 50, condition: 'new', type: 'album' });
      await createTestProduct(seller._id, { title: 'Mauvais état', kpopGroup: 'BTS', price: 15, condition: 'poor', type: 'album' });
      await createTestProduct(seller._id, { title: 'Mauvais type', kpopGroup: 'BTS', price: 15, condition: 'new' });
      await createTestProduct(seller._id, { title: 'Autre groupe', kpopGroup: 'TWICE', price: 15, condition: 'new', type: 'album' });
      await createTestProduct(seller._id, { title: 'Autre devise', kpopGroup: 'BTS', price: 15, condition: 'new', type: 'album', currency: 'USD' });

      const res = await search({
        groups: ['BTS'],
        priceRange: { min: 10, max: 20 },
        condition: ['new', 'likeNew'],
        type: 'album',
        currency: 'EUR'
      });

      expect(titlesOf(res)).toEqual(['Match']);
    });

    it('filtre sur les critères du catalogue (groupe, album, version, officiel)', async () => {
      const bts = await KpopGroup.create({ name: 'BTS' });
      const butter = await KpopAlbum.create({ name: 'Butter', artistId: bts._id, artistName: bts.name });
      const seller = await createTestUser();
      await createTestProduct(seller._id, { title: 'Match', group: bts._id, album: butter._id, version: 'Ver. A', isOfficial: true });
      await createTestProduct(seller._id, { title: 'Ancienne annonce', kpopGroup: 'BTS', albumName: 'Butter', version: 'Ver. A', isOfficial: true });
      await createTestProduct(seller._id, { title: 'Autre version', group: bts._id, album: butter._id, version: 'Ver. B', isOfficial: true });
      await createTestProduct(seller._id, { title: 'Non officielle', group: bts._id, album: butter._id, version: 'Ver. A', isOfficial: false });

      const res = await search({ group: String(bts._id), album: String(butter._id), version: 'Ver. A', isOfficial: true });

      expect(titlesOf(res)).toEqual(['Ancienne annonce', 'Match']);
      expect(res.body.searchMetadata.appliedFilters).toMatchObject({ group: String(bts._id), version: 'Ver. A' });
    });

    it('refuse (400) un critère de catalogue mal formé', async () => {
      const res = await search({ group: 'BTS' });

      expect(res.status).toBe(400);
      expect(res.body.message).toBe('Identifiant de groupe invalide');
    });

    it('trie et pagine avec le format unique de pagination', async () => {
      const seller = await createTestUser();
      await createTestProduct(seller._id, { title: 'A', price: 30 });
      await createTestProduct(seller._id, { title: 'B', price: 10 });
      await createTestProduct(seller._id, { title: 'C', price: 20 });

      const res = await search({ sortBy: 'price_asc', limit: 2, page: 2 });

      expect(res.body.products.map((p: { title: string }) => p.title)).toEqual(['A']);
      expect(res.body.pagination).toEqual({ page: 2, limit: 2, total: 3, pages: 2 });
    });

    it('ignore une requête texte qui n\'est pas du texte au lieu de répondre 500', async () => {
      const seller = await createTestUser();
      await createTestProduct(seller._id);

      const res = await search({ query: 42 });

      expect(res.status).toBe(200);
      expect(res.body.products).toHaveLength(1);
    });
  });

  describe('GET /api/search/suggestions', () => {
    it('suggère groupes actifs, albums et membres en vente', async () => {
      const [blackpink] = await KpopGroup.create([{ name: 'BLACKPINK', isActive: true }, { name: 'BLANK2Y', isActive: false }]);
      await KpopAlbum.create({ name: 'Blackout', artistId: blackpink._id, artistName: 'Inconnu' });
      const seller = await createTestUser();
      await createTestProduct(seller._id, { kpopMember: 'Blaze', kpopGroup: 'Groupe X' });
      await createTestProduct(seller._id, { kpopMember: 'Blanche', isAvailable: false });

      const res = await request(app).get('/api/search/suggestions?query=bla');

      expect(res.status).toBe(200);
      expect(res.body.suggestions.groups.map((g: { name: string }) => g.name)).toEqual(['BLACKPINK']);
      expect(res.body.suggestions.albums.map((a: { name: string }) => a.name)).toEqual(['Blackout']);
      expect(res.body.suggestions.members).toEqual([{ name: 'Blaze', groupName: 'Groupe X' }]);
    });

    it('refuse (400) une saisie trop courte', async () => {
      const res = await request(app).get('/api/search/suggestions?query=b');

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('BAD_REQUEST');
    });

    it('traite les caractères spéciaux comme du texte', async () => {
      const res = await request(app).get('/api/search/suggestions?query=.*(');

      expect(res.status).toBe(200);
    });
  });

  describe('historique de recherche', () => {
    async function historyOf(user: Awaited<ReturnType<typeof createTestUser>>, queries: string[]) {
      return await SearchHistory.create(queries.map((query) => ({ userId: user._id, query, resultCount: 0 })));
    }

    it('liste l\'historique du membre connecté seulement', async () => {
      const me = await createTestUser();
      const other = await createTestUser();
      await historyOf(me, ['bts']);
      await historyOf(other, ['twice']);

      const res = await request(app).get('/api/search/history').set('Authorization', auth(me));

      expect(res.status).toBe(200);
      expect(res.body.searchHistory.map((h: { query: string }) => h.query)).toEqual(['bts']);
    });

    it('supprime un élément, et répond 404 pour celui d\'un autre membre', async () => {
      const me = await createTestUser();
      const other = await createTestUser();
      const [mine] = await historyOf(me, ['bts']);
      const [theirs] = await historyOf(other, ['twice']);

      const deleted = await request(app).delete(`/api/search/history/${mine._id}`).set('Authorization', auth(me));
      const forbidden = await request(app).delete(`/api/search/history/${theirs._id}`).set('Authorization', auth(me));

      expect(deleted.status).toBe(200);
      expect(forbidden.status).toBe(404);
      expect(await SearchHistory.exists({ _id: theirs._id })).not.toBeNull();
    });

    it('vide l\'historique du membre', async () => {
      const me = await createTestUser();
      await historyOf(me, ['bts', 'twice']);

      const res = await request(app).delete('/api/search/history').set('Authorization', auth(me));

      expect(res.status).toBe(200);
      expect(await SearchHistory.countDocuments({ userId: me._id })).toBe(0);
    });
  });
});
