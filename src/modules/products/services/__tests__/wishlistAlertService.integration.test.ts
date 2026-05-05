jest.mock('../../../notifications/services/notificationService', () => ({
  NotificationService: {
    createNotification: jest.fn().mockResolvedValue(undefined)
  }
}));

import {
  startInMemoryMongo,
  stopInMemoryMongo,
  clearAllCollections
} from '../../../../tests/helpers/mongoMemory';
import { createTestUser, createTestProduct } from '../../../../tests/helpers/fixtures';
import { toggleFavoriteForUser, updateProductForOwner, markAsSold } from '../productService';
import { NotificationService } from '../../../notifications/services/notificationService';

describe('wishlistAlertService (integration)', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 60000);

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  beforeEach(async () => {
    await clearAllCollections();
    jest.clearAllMocks();
  });

  /**
   * Helper : reproduit le flux "deux utilisateurs ajoutent le produit à
   * leur wishlist". Le seller n'est jamais notifié (filtré dans le
   * broadcast) — on l'ignore donc côté assertions.
   */
  async function setupWithWishlisters() {
    const seller = await createTestUser();
    const wishlister1 = await createTestUser();
    const wishlister2 = await createTestUser();
    const product = await createTestProduct(seller._id, { price: 50 });

    await toggleFavoriteForUser(wishlister1._id.toString(), product._id.toString());
    await toggleFavoriteForUser(wishlister2._id.toString(), product._id.toString());
    return { seller, wishlister1, wishlister2, product };
  }

  describe('price drop', () => {
    it('notifie tous les wishlisters quand le prix baisse', async () => {
      const { seller, product } = await setupWithWishlisters();

      await updateProductForOwner({
        productId: product._id.toString(),
        userId: seller._id.toString(),
        body: { price: 30 }
      });

      // attend la fire-and-forget notification
      await new Promise((r) => setTimeout(r, 50));

      expect(NotificationService.createNotification).toHaveBeenCalledTimes(2);
      const call = (NotificationService.createNotification as jest.Mock).mock.calls[0][0];
      expect(call.type).toBe('wishlist_price_drop');
      expect(call.data.oldPrice).toBe(50);
      expect(call.data.newPrice).toBe(30);
      expect(call.data.dropPct).toBe(40);
    });

    it('ne notifie pas si le prix monte', async () => {
      const { seller, product } = await setupWithWishlisters();

      await updateProductForOwner({
        productId: product._id.toString(),
        userId: seller._id.toString(),
        body: { price: 60 }
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(NotificationService.createNotification).not.toHaveBeenCalled();
    });
  });

  describe('product unavailable', () => {
    it('notifie les wishlisters quand le produit est marqué vendu', async () => {
      const { seller, product } = await setupWithWishlisters();

      await markAsSold({
        productId: product._id.toString(),
        userId: seller._id.toString()
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(NotificationService.createNotification).toHaveBeenCalledTimes(2);
      const call = (NotificationService.createNotification as jest.Mock).mock.calls[0][0];
      expect(call.type).toBe('wishlist_unavailable');
      expect(call.data.reason).toBe('sold');
    });

    it('ne notifie pas le vendeur lui-même', async () => {
      const { seller, product } = await setupWithWishlisters();
      // le vendeur ajoute aussi son propre produit en favori (cas absurde mais possible)
      await toggleFavoriteForUser(seller._id.toString(), product._id.toString());

      await markAsSold({
        productId: product._id.toString(),
        userId: seller._id.toString()
      });

      await new Promise((r) => setTimeout(r, 50));

      const calls = (NotificationService.createNotification as jest.Mock).mock.calls;
      const recipientIds = calls.map((c) => c[0].recipientId.toString());
      expect(recipientIds).not.toContain(seller._id.toString());
    });
  });
});
