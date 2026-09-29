import {
  startInMemoryMongo,
  stopInMemoryMongo,
  clearAllCollections
} from '../../../../tests/helpers/mongoMemory';
import { createTestUser, createTestProduct } from '../../../../tests/helpers/fixtures';
import { fetchRecommendedProducts } from '../inventoryService';
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
});
