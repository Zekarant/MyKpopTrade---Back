import {
  startInMemoryMongo,
  stopInMemoryMongo,
  clearAllCollections
} from '../../../../tests/helpers/mongoMemory';
import { createTestUser, createTestProduct } from '../../../../tests/helpers/fixtures';
import { fetchRecommendedProducts, fetchUserFavorites, fetchUserInventory } from '../inventoryService';
import User from '../../../../models/userModel';

describe('inventoryService (integration)', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 60000);

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  beforeEach(async () => {
    await clearAllCollections();
  });

  describe('fetchRecommendedProducts', () => {
    it('n\'inclut pas les annonces de l\'utilisateur dans ses recommandations personnalisées', async () => {
      const seller = await createTestUser();
      const user = await createTestUser();
      const favorite = await createTestProduct(seller._id, { kpopGroup: 'BTS' });
      const otherListing = await createTestProduct(seller._id, { kpopGroup: 'BTS', title: 'Album BTS' });
      const ownListing = await createTestProduct(user._id, { kpopGroup: 'BTS', title: 'Ma photocard BTS' });
      await User.updateOne({ _id: user._id }, { favorites: [favorite._id] });

      const { products, isPersonalized } = await fetchRecommendedProducts(String(user._id), 10);
      const ids = products.map(product => String(product._id));

      expect(isPersonalized).toBe(true);
      expect(ids).toContain(String(otherListing._id));
      expect(ids).not.toContain(String(ownListing._id));
    });
  });

  describe('fetchUserInventory', () => {
    async function sellerWithListings() {
      const seller = await createTestUser();
      const onSale = await createTestProduct(seller._id, { title: 'En vente' });
      const sold = await createTestProduct(seller._id, { title: 'Vendu', isAvailable: false, isSold: true });
      const withdrawn = await createTestProduct(seller._id, { title: 'Retiré', isAvailable: false });
      return { sellerId: String(seller._id), onSale, sold, withdrawn };
    }

    const titles = (result: Awaited<ReturnType<typeof fetchUserInventory>>) =>
      result.products.map((product) => product.title);

    it('sépare les articles vendus des annonces retirées', async () => {
      const { sellerId } = await sellerWithListings();
      const inventory = (status: string) => fetchUserInventory({ sellerId, viewerId: sellerId, status, page: 1, limit: 20 });

      expect(titles(await inventory('sold'))).toEqual(['Vendu']);
      expect(titles(await inventory('withdrawn'))).toEqual(['Retiré']);
      expect((await inventory('available')).stats).toMatchObject({ totalProducts: 3, soldProducts: 1 });
    });

    it('ne montre pas les annonces retirées d\'un vendeur aux autres utilisateurs', async () => {
      const { sellerId } = await sellerWithListings();

      const result = await fetchUserInventory({ sellerId, status: 'withdrawn', page: 1, limit: 20 });

      expect(titles(result)).toEqual(['En vente']);
      expect(result.stats).toBeNull();
    });
  });

  describe('fetchUserFavorites', () => {
    it('signale les favoris vendus ou retirés et ignore ceux supprimés', async () => {
      const seller = await createTestUser();
      const user = await createTestUser();
      const onSale = await createTestProduct(seller._id, { title: 'En vente' });
      const sold = await createTestProduct(seller._id, { title: 'Vendu', isAvailable: false, isSold: true });
      const withdrawn = await createTestProduct(seller._id, { title: 'Retiré', isAvailable: false });
      const deleted = await createTestProduct(seller._id, { title: 'Supprimé' });
      await User.updateOne({ _id: user._id }, { favorites: [sold._id, withdrawn._id, onSale._id, deleted._id] });
      await deleted.deleteOne();

      const { products, pagination } = await fetchUserFavorites(String(user._id), 1, 20);
      const reasons = Object.fromEntries(products.map((product) => [product.title, product.unavailableReason]));

      expect(reasons).toEqual({ 'En vente': null, 'Vendu': 'sold', 'Retiré': 'withdrawn' });
      expect(products[0].title).toBe('En vente');
      expect(pagination.total).toBe(3);
    });

    it('ne renvoie pas l\'analyse de modération d\'un favori suspendu', async () => {
      const seller = await createTestUser();
      const user = await createTestUser();
      const suspended = await createTestProduct(seller._id, {
        isAvailable: false,
        moderationFlag: {
          suspect: true, confidence: 'high', reasoning: 'test', categories: ['counterfeit'], matchedKeywords: [],
          keywordsVersion: '1', policyVersion: '1', model: 'm', provider: 'mistral', analyzedAt: new Date()
        }
      });
      await User.updateOne({ _id: user._id }, { favorites: [suspended._id] });

      const { products } = await fetchUserFavorites(String(user._id), 1, 20);

      expect(products[0]).not.toHaveProperty('moderationFlag');
      expect(products[0].unavailableReason).toBe('withdrawn');
    });
  });
});
