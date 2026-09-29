import {
  startInMemoryMongo,
  stopInMemoryMongo,
  clearAllCollections
} from '../../../../tests/helpers/mongoMemory';
import { createTestUser, createTestProduct } from '../../../../tests/helpers/fixtures';
import * as cartService from '../cartService';
import { checkoutCart } from '../cartCheckoutService';
import { PayPalService } from '../../../payments/services/paypalService';
import Product from '../../../../models/productModel';
import Payment from '../../../../models/paymentModel';

/**
 * Checkout du panier : tout ou rien. Chaque paiement réserve son produit ; un
 * échec au milieu ne doit laisser aucun produit réservé sans lien de paiement.
 */
describe('checkoutCart (integration)', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 60000);

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  beforeEach(async () => {
    await clearAllCollections();
    jest.restoreAllMocks();
  });

  const connectedSeller = () =>
    createTestUser({ paypalConnected: true, paypalMerchantId: `MERCHANT${Math.random().toString(36).slice(2, 8)}` });

  /** Simule PayPal : réserve le produit et enregistre le paiement, comme le vrai service. */
  function fakePayPal(failOnProductId?: string) {
    return jest.spyOn(PayPalService, 'createDirectPayment').mockImplementation(async (productId: string, buyerId: string) => {
      if (productId === failOnProductId) throw new Error('PayPal indisponible');
      const product = await Product.findByIdAndUpdate(productId, { isReserved: true, reservedFor: buyerId });
      const orderId = `ORDER-${productId}`;
      const payment = await Payment.create({
        product: productId,
        buyer: buyerId,
        seller: product!.seller,
        amount: product!.price,
        currency: 'EUR',
        paymentIntentId: orderId,
        status: 'pending'
      });
      return { orderId, paymentId: payment._id, approvalUrl: `https://paypal.test/${orderId}`, amount: product!.price, currency: 'EUR' };
    });
  }

  it('crée un paiement par produit quand tout va bien', async () => {
    const buyer = await createTestUser();
    const seller = await connectedSeller();
    const a = await createTestProduct(seller._id, { title: 'A' });
    const b = await createTestProduct(seller._id, { title: 'B' });
    await cartService.addItem(buyer._id.toString(), a._id.toString());
    await cartService.addItem(buyer._id.toString(), b._id.toString());
    fakePayPal();

    const results = await checkoutCart(buyer._id.toString(), { shippingMethod: 'national' });

    expect(results.map((r) => r.productIds[0]).sort()).toEqual([a._id.toString(), b._id.toString()].sort());
  });

  it('libère les produits déjà réservés si un paiement suivant échoue', async () => {
    const buyer = await createTestUser();
    const seller = await connectedSeller();
    const first = await createTestProduct(seller._id, { title: 'Premier' });
    const second = await createTestProduct(seller._id, { title: 'Second' });
    await cartService.addItem(buyer._id.toString(), first._id.toString());
    await cartService.addItem(buyer._id.toString(), second._id.toString());
    fakePayPal(second._id.toString());

    await expect(checkoutCart(buyer._id.toString(), { shippingMethod: 'national' })).rejects.toMatchObject({
      statusCode: 400
    });

    const released = await Product.findById(first._id);
    expect(released!.isReserved).toBe(false);
    expect(await Payment.findOne({ paymentIntentId: `ORDER-${first._id}` })).toMatchObject({ status: 'cancelled' });
  });

  it('refuse tout le panier, sans rien réserver, si un vendeur n\'est pas relié à PayPal', async () => {
    const buyer = await createTestUser();
    const ready = await connectedSeller();
    const notReady = await createTestUser();
    const payable = await createTestProduct(ready._id, { title: 'Payable' });
    const blocked = await createTestProduct(notReady._id, { title: 'Bloqué' });
    await cartService.addItem(buyer._id.toString(), payable._id.toString());
    await cartService.addItem(buyer._id.toString(), blocked._id.toString());
    const paypal = fakePayPal();

    await expect(checkoutCart(buyer._id.toString(), { shippingMethod: 'national' })).rejects.toThrow(
      /"Bloqué" n'est pas connecté à PayPal/
    );

    expect(paypal).not.toHaveBeenCalled();
    expect((await Product.findById(payable._id))!.isReserved).not.toBe(true);
  });

  it('nomme le produit indisponible dans le message d\'erreur', async () => {
    const buyer = await createTestUser();
    const seller = await connectedSeller();
    const product = await createTestProduct(seller._id, { title: 'Album Proof' });
    await cartService.addItem(buyer._id.toString(), product._id.toString());
    await Product.updateOne({ _id: product._id }, { isAvailable: false });

    await expect(checkoutCart(buyer._id.toString(), { shippingMethod: 'national' })).rejects.toThrow(
      /"Album Proof" n'est plus disponible/
    );
  });
});
