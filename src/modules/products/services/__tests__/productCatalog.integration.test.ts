import { Types } from 'mongoose';
import {
  startInMemoryMongo,
  stopInMemoryMongo,
  clearAllCollections
} from '../../../../tests/helpers/mongoMemory';
import { createTestUser, createTestProduct } from '../../../../tests/helpers/fixtures';
import { listProducts, updateProductForOwner, fetchProductById } from '../productService';
import { runAdvancedSearch } from '../../../search/services/searchService';
import KpopGroup from '../../../../models/kpopGroupModel';
import KpopAlbum from '../../../../models/albumModel';

/** Métadonnées structurées des annonces : cohérence avec le catalogue et filtres. */
describe('métadonnées catalogue des annonces (integration)', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 60000);

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  beforeEach(async () => {
    await clearAllCollections();
  });

  async function aCatalog() {
    const [bts, twice] = await KpopGroup.create([
      { name: 'BTS', members: ['Jungkook', 'Jimin'] },
      { name: 'TWICE' }
    ]);
    const butter = await KpopAlbum.create({ name: 'Butter', artistId: bts._id, artistName: bts.name });
    const fancy = await KpopAlbum.create({ name: 'Fancy You', artistId: twice._id, artistName: twice.name });
    return { bts, twice, butter, fancy };
  }

  describe('updateProductForOwner', () => {
    it('enregistre groupe, membre, album, version et caractère officiel', async () => {
      const { bts, butter } = await aCatalog();
      const seller = await createTestUser();
      const product = await createTestProduct(seller._id);

      const updated = await updateProductForOwner({
        productId: product._id.toString(),
        userId: seller._id.toString(),
        body: {
          group: bts._id.toString(), member: 'Jungkook', album: butter._id.toString(),
          version: 'Ver. A', era: 'Butter', pob: 'Weverse', isOfficial: true
        }
      });

      expect(updated).toMatchObject({ member: 'Jungkook', version: 'Ver. A', era: 'Butter', pob: 'Weverse', isOfficial: true });
      expect(String(updated?.group)).toBe(bts._id.toString());
      expect(String(updated?.album)).toBe(butter._id.toString());
    });

    it.each([
      ['un groupe inexistant', () => ({ group: new Types.ObjectId().toString() })],
      ['un membre absent de la liste du groupe', ({ bts }: Awaited<ReturnType<typeof aCatalog>>) => ({ group: bts._id.toString(), member: 'Lisa' })],
      ['un album d\'un autre groupe', ({ bts, fancy }: Awaited<ReturnType<typeof aCatalog>>) => ({ group: bts._id.toString(), album: fancy._id.toString() })]
    ])('refuse (400) %s', async (_label, buildBody) => {
      const catalog = await aCatalog();
      const seller = await createTestUser();
      const product = await createTestProduct(seller._id);

      await expect(updateProductForOwner({
        productId: product._id.toString(),
        userId: seller._id.toString(),
        body: buildBody(catalog)
      })).rejects.toMatchObject({ statusCode: 400 });
    });

    it('accepte un membre libre quand le groupe n\'a pas de liste de membres', async () => {
      const { twice } = await aCatalog();
      const seller = await createTestUser();
      const product = await createTestProduct(seller._id);

      const updated = await updateProductForOwner({
        productId: product._id.toString(),
        userId: seller._id.toString(),
        body: { group: twice._id.toString(), member: 'Nayeon' }
      });

      expect(updated?.member).toBe('Nayeon');
    });

    it('contrôle un membre modifié seul contre le groupe déjà enregistré', async () => {
      const { bts } = await aCatalog();
      const seller = await createTestUser();
      const product = await createTestProduct(seller._id, { group: bts._id });

      await expect(updateProductForOwner({
        productId: product._id.toString(),
        userId: seller._id.toString(),
        body: { member: 'Lisa' }
      })).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  it('le détail expose les métadonnées et résout les noms depuis les références', async () => {
    const { bts, butter } = await aCatalog();
    const seller = await createTestUser();
    const product = await createTestProduct(seller._id, {
      kpopGroup: 'ancien texte', group: bts._id, album: butter._id, version: 'Ver. B', isOfficial: true
    });

    const { product: detail } = await fetchProductById(product._id.toString());

    expect(detail).toMatchObject({
      version: 'Ver. B', isOfficial: true,
      kpopGroupName: 'BTS', kpopGroupId: bts._id.toString(),
      albumNameStr: 'Butter', albumId: butter._id.toString()
    });
  });

  describe('listProducts', () => {
    it('filtre par groupe, y compris les anciennes annonces désignant le groupe par son nom ou son id', async () => {
      const { bts } = await aCatalog();
      const seller = await createTestUser();
      const structured = await createTestProduct(seller._id, { group: bts._id });
      const legacyByName = await createTestProduct(seller._id, { kpopGroup: 'BTS' });
      const legacyById = await createTestProduct(seller._id, { kpopGroup: bts._id.toString() });
      await createTestProduct(seller._id, { kpopGroup: 'TWICE' });

      const { products, pagination } = await listProducts({ group: bts._id.toString() });

      expect(products.map((p) => p._id.toString()).sort()).toEqual(
        [structured, legacyByName, legacyById].map((p) => p._id.toString()).sort()
      );
      expect(pagination.total).toBe(3);
    });

    it('combine membre, album, version et officiel', async () => {
      const { bts, butter } = await aCatalog();
      const seller = await createTestUser();
      const match = await createTestProduct(seller._id, {
        group: bts._id, member: 'Jimin', album: butter._id, version: 'Ver. A', isOfficial: true
      });
      await createTestProduct(seller._id, { group: bts._id, member: 'Jimin', album: butter._id, version: 'Ver. B', isOfficial: true });
      await createTestProduct(seller._id, { group: bts._id, member: 'Jungkook', album: butter._id, version: 'Ver. A', isOfficial: true });
      await createTestProduct(seller._id, { group: bts._id, member: 'Jimin', album: butter._id, version: 'Ver. A', isOfficial: false });

      const { products } = await listProducts({
        group: bts._id.toString(), member: 'Jimin', album: butter._id.toString(), version: 'Ver. A', isOfficial: 'true'
      });

      expect(products.map((p) => p._id.toString())).toEqual([match._id.toString()]);
    });

    it.each([
      ['un groupe mal formé', { group: 'BTS' }],
      ['un album mal formé', { album: '123' }],
      ['un booléen inconnu', { isOfficial: 'oui' }]
    ])('refuse (400) %s', async (_label, query) => {
      await expect(listProducts(query)).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  describe('runAdvancedSearch', () => {
    const search = (filters: Record<string, unknown>) =>
      runAdvancedSearch({ filters, includeOwnProducts: true, page: 1, limit: 20, sortBy: 'newest' });

    it('filtre par groupe et membre, en plus de la recherche texte', async () => {
      const { bts } = await aCatalog();
      const seller = await createTestUser();
      const match = await createTestProduct(seller._id, { title: 'Photocard Jimin BE', group: bts._id, member: 'Jimin' });
      await createTestProduct(seller._id, { title: 'Photocard Jimin Butter', kpopGroup: 'TWICE', kpopMember: 'Jimin' });
      await createTestProduct(seller._id, { title: 'Photocard Jungkook', group: bts._id, member: 'Jungkook' });

      const result = await search({ query: 'Photocard', group: bts._id.toString(), member: 'Jimin' });

      expect(result.products.map((p) => p._id.toString())).toEqual([match._id.toString()]);
      expect(result.searchMetadata.appliedFilters).toMatchObject({ group: bts._id.toString(), member: 'Jimin' });
    });

    it('filtre les annonces officielles', async () => {
      const seller = await createTestUser();
      const official = await createTestProduct(seller._id, { isOfficial: true });
      await createTestProduct(seller._id, { isOfficial: false });
      await createTestProduct(seller._id);

      const result = await search({ isOfficial: true });

      expect(result.products.map((p) => p._id.toString())).toEqual([official._id.toString()]);
    });

    it('refuse (400) un identifiant d\'album mal formé', async () => {
      await expect(search({ album: { $ne: null } })).rejects.toMatchObject({ statusCode: 400 });
    });
  });
});
