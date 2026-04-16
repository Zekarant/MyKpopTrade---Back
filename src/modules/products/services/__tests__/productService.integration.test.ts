import {
  startInMemoryMongo,
  stopInMemoryMongo,
  clearAllCollections
} from '../../../../tests/helpers/mongoMemory';
import { createTestUser, createTestProduct } from '../../../../tests/helpers/fixtures';
import { toggleFavoriteForUser, removeProduct } from '../productService';
import { HttpError } from '../../../../commons/utils/httpError';
import User from '../../../../models/userModel';
import Product from '../../../../models/productModel';

describe('productService (integration)', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 60000);

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  beforeEach(async () => {
    await clearAllCollections();
  });

  describe('toggleFavoriteForUser', () => {
    it('ajoute le produit aux favoris et incrémente le compteur', async () => {
      const seller = await createTestUser();
      const buyer = await createTestUser();
      const product = await createTestProduct(seller._id);

      const isFavorite = await toggleFavoriteForUser(
        buyer._id.toString(),
        product._id.toString()
      );

      expect(isFavorite).toBe(true);

      const refreshedUser = await User.findById(buyer._id);
      expect(refreshedUser?.favorites?.map((id: any) => id.toString())).toContain(product._id.toString());

      const refreshedProduct = await Product.findById(product._id);
      expect(refreshedProduct?.favorites).toBe(1);
    });

    it('retire le produit des favoris au second appel et décrémente', async () => {
      const seller = await createTestUser();
      const buyer = await createTestUser();
      const product = await createTestProduct(seller._id);

      await toggleFavoriteForUser(buyer._id.toString(), product._id.toString());
      const isFavorite = await toggleFavoriteForUser(
        buyer._id.toString(),
        product._id.toString()
      );

      expect(isFavorite).toBe(false);

      const refreshedUser = await User.findById(buyer._id);
      expect(refreshedUser?.favorites?.map((id: any) => id.toString())).not.toContain(product._id.toString());

      const refreshedProduct = await Product.findById(product._id);
      expect(refreshedProduct?.favorites).toBe(0);
    });

    it('rejette avec HttpError 400 si l\'ID est invalide', async () => {
      await expect(
        toggleFavoriteForUser('someUser', 'not-an-object-id')
      ).rejects.toThrow(HttpError);
    });

    it('rejette avec HttpError 404 si le produit est inexistant', async () => {
      const buyer = await createTestUser();
      const ghostProductId = '507f1f77bcf86cd799439011';

      await expect(
        toggleFavoriteForUser(buyer._id.toString(), ghostProductId)
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it('ne double-décrémente pas le compteur favorites sous zéro', async () => {
      const seller = await createTestUser();
      const buyer = await createTestUser();
      const product = await createTestProduct(seller._id, { favorites: 0 });

      await toggleFavoriteForUser(buyer._id.toString(), product._id.toString());
      await toggleFavoriteForUser(buyer._id.toString(), product._id.toString());

      const refreshedProduct = await Product.findById(product._id);
      expect(refreshedProduct?.favorites).toBeGreaterThanOrEqual(0);
    });
  });

  describe('removeProduct', () => {
    it('archive le produit en soft-delete (isAvailable false)', async () => {
      const seller = await createTestUser();
      const product = await createTestProduct(seller._id);

      const result = await removeProduct({
        productId: product._id.toString(),
        userId: seller._id.toString(),
        soft: true
      });

      expect(result.soft).toBe(true);
      const refreshed = await Product.findById(product._id);
      expect(refreshed?.isAvailable).toBe(false);
    });

    it('supprime définitivement le produit en hard-delete', async () => {
      const seller = await createTestUser();
      const product = await createTestProduct(seller._id);

      await removeProduct({
        productId: product._id.toString(),
        userId: seller._id.toString(),
        soft: false
      });

      const refreshed = await Product.findById(product._id);
      expect(refreshed).toBeNull();
    });

    it('rejette avec 403 si l\'utilisateur n\'est pas le vendeur', async () => {
      const seller = await createTestUser();
      const attacker = await createTestUser();
      const product = await createTestProduct(seller._id);

      await expect(
        removeProduct({
          productId: product._id.toString(),
          userId: attacker._id.toString(),
          soft: false
        })
      ).rejects.toMatchObject({ statusCode: 403 });
    });
  });
});
