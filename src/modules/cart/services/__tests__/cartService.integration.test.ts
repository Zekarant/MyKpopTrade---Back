import {
  startInMemoryMongo,
  stopInMemoryMongo,
  clearAllCollections
} from '../../../../tests/helpers/mongoMemory';
import { createTestUser, createTestProduct } from '../../../../tests/helpers/fixtures';
import * as cartService from '../cartService';
import { HttpError } from '../../../../commons/utils/httpError';
import Cart from '../../../../models/cartModel';
import mongoose from 'mongoose';

describe('cartService (integration)', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 60000);

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  beforeEach(async () => {
    await clearAllCollections();
  });

  describe('getCart', () => {
    it('crée un panier vide si inexistant', async () => {
      const user = await createTestUser();
      const cart = await cartService.getCart(user._id.toString());

      expect(cart).toBeDefined();
      expect(cart.items).toHaveLength(0);
      expect(cart.user.toString()).toBe(user._id.toString());
    });

    it('retourne le panier existant', async () => {
      const user = await createTestUser();
      const seller = await createTestUser();
      const product = await createTestProduct(seller._id);

      await cartService.addItem(user._id.toString(), product._id.toString());
      const cart = await cartService.getCart(user._id.toString());

      expect(cart.items).toHaveLength(1);
    });
  });

  describe('addItem', () => {
    it('ajoute un produit au panier avec snapshot du prix', async () => {
      const buyer = await createTestUser();
      const seller = await createTestUser();
      const product = await createTestProduct(seller._id, { price: 15, currency: 'EUR' });

      const cart = await cartService.addItem(buyer._id.toString(), product._id.toString());

      expect(cart.items).toHaveLength(1);
      expect(cart.items[0].priceSnapshot).toBe(15);
      expect(cart.items[0].currencySnapshot).toBe('EUR');
    });

    it('refuse un produit déjà dans le panier', async () => {
      const buyer = await createTestUser();
      const seller = await createTestUser();
      const product = await createTestProduct(seller._id);

      await cartService.addItem(buyer._id.toString(), product._id.toString());

      await expect(
        cartService.addItem(buyer._id.toString(), product._id.toString())
      ).rejects.toThrow(HttpError);

      await expect(
        cartService.addItem(buyer._id.toString(), product._id.toString())
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('refuse un produit non disponible', async () => {
      const buyer = await createTestUser();
      const seller = await createTestUser();
      const product = await createTestProduct(seller._id, { isAvailable: false });

      await expect(
        cartService.addItem(buyer._id.toString(), product._id.toString())
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('refuse un produit vendu', async () => {
      const buyer = await createTestUser();
      const seller = await createTestUser();
      const product = await createTestProduct(seller._id, { isSold: true });

      await expect(
        cartService.addItem(buyer._id.toString(), product._id.toString())
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('refuse d\'ajouter son propre produit', async () => {
      const user = await createTestUser();
      const product = await createTestProduct(user._id);

      await expect(
        cartService.addItem(user._id.toString(), product._id.toString())
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('refuse un productId invalide', async () => {
      const buyer = await createTestUser();

      await expect(
        cartService.addItem(buyer._id.toString(), 'invalid-id')
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('refuse un productId inexistant', async () => {
      const buyer = await createTestUser();
      const fakeId = new mongoose.Types.ObjectId().toString();

      await expect(
        cartService.addItem(buyer._id.toString(), fakeId)
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it('refuse au-delà de la limite max d\'articles', async () => {
      const buyer = await createTestUser();
      const seller = await createTestUser();

      // Ajouter 20 articles (la limite)
      for (let i = 0; i < 20; i++) {
        const p = await createTestProduct(seller._id, { title: `Produit ${i}` });
        await cartService.addItem(buyer._id.toString(), p._id.toString());
      }

      const extraProduct = await createTestProduct(seller._id, { title: 'Extra' });
      await expect(
        cartService.addItem(buyer._id.toString(), extraProduct._id.toString())
      ).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  describe('removeItem', () => {
    it('retire un produit du panier', async () => {
      const buyer = await createTestUser();
      const seller = await createTestUser();
      const product = await createTestProduct(seller._id);

      await cartService.addItem(buyer._id.toString(), product._id.toString());
      const cart = await cartService.removeItem(buyer._id.toString(), product._id.toString());

      expect(cart.items).toHaveLength(0);
    });

    it('refuse un productId absent du panier', async () => {
      const buyer = await createTestUser();
      const seller = await createTestUser();
      const product = await createTestProduct(seller._id);

      await cartService.addItem(buyer._id.toString(), product._id.toString());

      const other = await createTestProduct(seller._id, { title: 'Autre' });
      await expect(
        cartService.removeItem(buyer._id.toString(), other._id.toString())
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it('refuse un productId invalide', async () => {
      const buyer = await createTestUser();

      await expect(
        cartService.removeItem(buyer._id.toString(), 'not-an-id')
      ).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  describe('clearCart', () => {
    it('vide le panier', async () => {
      const buyer = await createTestUser();
      const seller = await createTestUser();
      const p1 = await createTestProduct(seller._id);
      const p2 = await createTestProduct(seller._id, { title: 'Autre' });

      await cartService.addItem(buyer._id.toString(), p1._id.toString());
      await cartService.addItem(buyer._id.toString(), p2._id.toString());

      await cartService.clearCart(buyer._id.toString());
      const cart = await Cart.findOne({ user: buyer._id });

      expect(cart?.items).toHaveLength(0);
    });

    it('ne fait rien si le panier n\'existe pas', async () => {
      const user = await createTestUser();
      await expect(cartService.clearCart(user._id.toString())).resolves.toBeUndefined();
    });
  });

  describe('validateCart', () => {
    it('retourne valid=true si tout est ok', async () => {
      const buyer = await createTestUser();
      const seller = await createTestUser();
      const product = await createTestProduct(seller._id, { price: 10, currency: 'EUR' });

      await cartService.addItem(buyer._id.toString(), product._id.toString());
      const result = await cartService.validateCart(buyer._id.toString());

      expect(result.valid).toBe(true);
      expect(result.issues).toHaveLength(0);
      expect(result.validItems).toHaveLength(1);
    });

    it('détecte un produit non disponible', async () => {
      const buyer = await createTestUser();
      const seller = await createTestUser();
      const product = await createTestProduct(seller._id);

      await cartService.addItem(buyer._id.toString(), product._id.toString());

      // Marquer comme vendu après ajout au panier
      const Product = (await import('../../../../models/productModel')).default;
      await Product.findByIdAndUpdate(product._id, { isSold: true, isAvailable: false });

      const result = await cartService.validateCart(buyer._id.toString());

      expect(result.valid).toBe(false);
      expect(result.issues.length).toBeGreaterThan(0);
    });

    it('détecte un changement de prix', async () => {
      const buyer = await createTestUser();
      const seller = await createTestUser();
      const product = await createTestProduct(seller._id, { price: 10 });

      await cartService.addItem(buyer._id.toString(), product._id.toString());

      // Modifier le prix après ajout
      const Product = (await import('../../../../models/productModel')).default;
      await Product.findByIdAndUpdate(product._id, { price: 25 });

      const result = await cartService.validateCart(buyer._id.toString());

      expect(result.valid).toBe(false);
      expect(result.issues.some(i => i.includes('prix'))).toBe(true);
    });

    it('refuse un panier vide', async () => {
      const buyer = await createTestUser();
      await Cart.create({ user: buyer._id, items: [] });

      await expect(
        cartService.validateCart(buyer._id.toString())
      ).rejects.toMatchObject({ statusCode: 400 });
    });
  });
});
