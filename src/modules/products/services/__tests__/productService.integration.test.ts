import { Types } from 'mongoose';
import {
  startInMemoryMongo,
  stopInMemoryMongo,
  clearAllCollections
} from '../../../../tests/helpers/mongoMemory';
import { createTestUser, createTestProduct } from '../../../../tests/helpers/fixtures';
import {
  toggleFavoriteForUser,
  removeProduct,
  updateProductForOwner,
  fetchProductById,
  listProducts,
  markAsSold
} from '../productService';
import { HttpError } from '../../../../commons/utils/httpError';
import User from '../../../../models/userModel';
import Product from '../../../../models/productModel';
import Payment from '../../../../models/paymentModel';

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
      expect(refreshedUser?.favorites?.map((id) => id.toString())).toContain(product._id.toString());

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
      expect(refreshedUser?.favorites?.map((id) => id.toString())).not.toContain(product._id.toString());

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

  describe('updateProductForOwner', () => {
    it('met à jour le type et l\'acceptation des offres depuis le formulaire de modification', async () => {
      const seller = await createTestUser();
      const product = await createTestProduct(seller._id, { type: 'photocard', allowOffers: false });

      const updated = await updateProductForOwner({
        productId: product._id.toString(),
        userId: seller._id.toString(),
        body: { type: 'album', allowOffers: true }
      });

      expect(updated?.type).toBe('album');
      expect(updated?.allowOffers).toBe(true);
    });

    it('ignore les images et le prix libre envoyés dans le corps', async () => {
      const seller = await createTestUser();
      const product = await createTestProduct(seller._id);

      const updated = await updateProductForOwner({
        productId: product._id.toString(),
        userId: seller._id.toString(),
        body: {
          title: 'Nouveau titre',
          images: ['/etc/passwd'],
          isPayWhatYouWant: true,
          pwywMinPrice: 1
        }
      });

      expect(updated?.title).toBe('Nouveau titre');
      expect(updated?.images).toEqual(['/uploads/products/test.jpg']);
      expect(updated?.isPayWhatYouWant).toBe(false);
      expect(updated?.pwywMinPrice).toBeUndefined();
    });

    it.each([
      ['un titre trop court', { title: 'ab' }],
      ['un prix négatif', { price: -5 }],
      ['un état inconnu', { condition: 'cassé' }],
      ['une devise non supportée', { currency: 'BTC' }],
      ['des frais de port négatifs', { shippingOptions: { nationalOnly: true, nationalCost: -1 } }],
      ['un titre qui n\'est pas du texte', { title: { $gt: '' } }]
    ])('refuse (400) %s, comme à la création', async (_label, body) => {
      const seller = await createTestUser();
      const product = await createTestProduct(seller._id);

      await expect(updateProductForOwner({
        productId: product._id.toString(),
        userId: seller._id.toString(),
        body
      })).rejects.toMatchObject({ statusCode: 400 });
      expect((await Product.findById(product._id))?.title).toBe(product.title);
    });

    it('n\'ajoute aucune valeur par défaut aux champs absents d\'une mise à jour partielle', async () => {
      const seller = await createTestUser();
      const product = await createTestProduct(seller._id, { currency: 'USD', allowOffers: true });

      const updated = await updateProductForOwner({
        productId: product._id.toString(),
        userId: seller._id.toString(),
        body: { price: '15' }
      });

      expect(updated?.price).toBe(15);
      expect(updated?.currency).toBe('USD');
      expect(updated?.allowOffers).toBe(true);
    });
  });

  describe('listProducts', () => {
    it('plafonne la taille de page à 100', async () => {
      const result = await listProducts({ limit: '500' });

      expect(result.pagination.limit).toBe(100);
    });

    it('accepte un tri de la liste autorisée', async () => {
      const seller = await createTestUser();
      await createTestProduct(seller._id, { price: 30 });
      await createTestProduct(seller._id, { price: 10 });

      const result = await listProducts({ sort: 'price' });

      expect(result.products.map((product) => product.price)).toEqual([10, 30]);
    });

    it('refuse (400) un tri hors liste', async () => {
      await expect(listProducts({ sort: 'moderationFlag.suspect' })).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  describe('markAsSold', () => {
    it('n\'ajoute pas d\'achat au vendeur quand son propre identifiant est transmis comme acheteur', async () => {
      const seller = await createTestUser();
      const product = await createTestProduct(seller._id);

      await markAsSold({
        productId: product._id.toString(),
        userId: seller._id.toString(),
        buyerId: seller._id.toString()
      });

      const refreshedSeller = await User.findById(seller._id);
      expect(refreshedSeller?.statistics?.totalSales).toBe(1);
      expect(refreshedSeller?.statistics?.totalPurchases ?? 0).toBe(0);
      const refreshed = await Product.findById(product._id);
      expect(refreshed?.isAvailable).toBe(false);
      expect(refreshed?.isSold).toBe(true);
      expect(refreshed?.soldAt).toBeInstanceOf(Date);
      expect(refreshed?.soldTo).toBeUndefined();
    });

    it('compte l\'achat de l\'acheteur désigné', async () => {
      const seller = await createTestUser();
      const buyer = await createTestUser();
      const product = await createTestProduct(seller._id);

      await markAsSold({
        productId: product._id.toString(),
        userId: seller._id.toString(),
        buyerId: buyer._id.toString()
      });

      expect((await User.findById(buyer._id))?.statistics?.totalPurchases).toBe(1);
      expect(String((await Product.findById(product._id))?.soldTo)).toBe(buyer._id.toString());
    });

    it('refuse (409) un article déjà vendu, sans compter une seconde vente', async () => {
      const seller = await createTestUser();
      const product = await createTestProduct(seller._id);
      const sale = { productId: product._id.toString(), userId: seller._id.toString() };
      await markAsSold(sale);

      await expect(markAsSold(sale)).rejects.toMatchObject({ statusCode: 409 });
      expect((await User.findById(seller._id))?.statistics?.totalSales).toBe(1);
    });

    it('refuse (400) un acheteur qui n\'existe pas, sans marquer l\'article vendu', async () => {
      const seller = await createTestUser();
      const product = await createTestProduct(seller._id);

      await expect(markAsSold({
        productId: product._id.toString(),
        userId: seller._id.toString(),
        buyerId: new Types.ObjectId().toString()
      })).rejects.toMatchObject({ statusCode: 400 });
      expect((await Product.findById(product._id))?.isSold).toBeFalsy();
    });

    it('refuse (400) un acheteur qui n\'est pas une chaîne', async () => {
      const seller = await createTestUser();
      const product = await createTestProduct(seller._id);

      await expect(markAsSold({
        productId: product._id.toString(),
        userId: seller._id.toString(),
        buyerId: [seller._id.toString()] as unknown as string
      })).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  describe('remise en vente', () => {
    const relist = (productId: unknown, userId: unknown) =>
      updateProductForOwner({ productId: String(productId), userId: String(userId), body: { isAvailable: true } });

    it('annule une vente déclarée à la main et ses statistiques', async () => {
      const seller = await createTestUser();
      const buyer = await createTestUser();
      const product = await createTestProduct(seller._id);
      await markAsSold({ productId: product._id.toString(), userId: seller._id.toString(), buyerId: buyer._id.toString() });

      const relisted = await relist(product._id, seller._id);

      expect(relisted).toMatchObject({ isAvailable: true, isSold: false });
      expect(relisted?.soldAt).toBeUndefined();
      expect(relisted?.soldTo).toBeUndefined();
      expect((await User.findById(seller._id))?.statistics?.totalSales).toBe(0);
      expect((await User.findById(buyer._id))?.statistics?.totalPurchases).toBe(0);
    });

    it('remet en vente une annonce retirée sans toucher aux statistiques', async () => {
      const seller = await createTestUser();
      const product = await createTestProduct(seller._id, { isAvailable: false });

      const relisted = await relist(product._id, seller._id);

      expect(relisted?.isAvailable).toBe(true);
      expect((await User.findById(seller._id))?.statistics?.totalSales ?? 0).toBe(0);
    });

    it('refuse (409) de remettre en vente un article payé via la plateforme', async () => {
      const seller = await createTestUser();
      const buyer = await createTestUser();
      const product = await createTestProduct(seller._id, { isSold: true, isAvailable: false, soldTo: buyer._id });
      await Payment.create({
        product: product._id, buyer: buyer._id, seller: seller._id,
        amount: 20, currency: 'EUR', paymentIntentId: 'ORDER-PAID', status: 'completed'
      });

      await expect(relist(product._id, seller._id)).rejects.toMatchObject({ statusCode: 409 });
      expect((await Product.findById(product._id))?.isSold).toBe(true);
    });
  });

  describe('prix libre dans les réponses', () => {
    it('le détail et la liste exposent isPayWhatYouWant et la fourchette', async () => {
      const seller = await createTestUser();
      const product = await createTestProduct(seller._id, {
        isPayWhatYouWant: true,
        pwywMinPrice: 5,
        pwywMaxPrice: 30
      });

      const { product: detail } = await fetchProductById(product._id.toString());
      expect(detail).toMatchObject({ isPayWhatYouWant: true, pwywMinPrice: 5, pwywMaxPrice: 30 });

      const { products } = await listProducts({});
      expect(products[0]).toMatchObject({ isPayWhatYouWant: true, pwywMinPrice: 5, pwywMaxPrice: 30 });
    });
  });
});
