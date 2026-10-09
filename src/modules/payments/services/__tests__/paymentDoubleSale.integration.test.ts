jest.mock('../../../notifications/services/notificationService', () => ({
  NotificationService: { createNotification: jest.fn().mockResolvedValue(undefined) }
}));
jest.mock('../paypalClient', () => ({
  PayPalClient: {
    getAccessToken: jest.fn().mockResolvedValue('platform-token'),
    checkPaymentStatus: jest.fn().mockResolvedValue('COMPLETED')
  },
  paypalHttp: { get: jest.fn(), post: jest.fn() },
  partnerHeaders: () => ({}),
  extractDebugId: () => undefined
}));

import { paypalHttp } from '../paypalClient';
import {
  startInMemoryMongo,
  stopInMemoryMongo,
  clearAllCollections
} from '../../../../tests/helpers/mongoMemory';
import { createTestProduct, createTestUser } from '../../../../tests/helpers/fixtures';
import Product from '../../../../models/productModel';
import Payment from '../../../../models/paymentModel';
import { PayPalPaymentService } from '../paypalPaymentService';
import { PayPalPartnerService } from '../paypalPartnerService';
import { PayPalService } from '../paypalService';
import { captureDirectPayment } from '../paymentService';

/**
 * Ces tests verrouillent l'anti double-vente. Les produits ne sont pas réservés
 * pendant le paiement : plusieurs acheteurs peuvent ouvrir un ordre, mais le
 * produit n'est encaissé qu'une fois, par le premier qui capture.
 */

const mockedPost = paypalHttp.post as jest.Mock;
let orderCounter = 0;

const LOCAL_PICKUP = { shippingMethod: 'localPickup' };

async function setupSale() {
  const seller = await createTestUser({ paypalMerchantId: 'MERCHANT-1' });
  const buyerA = await createTestUser();
  const buyerB = await createTestUser();
  const product = await createTestProduct(seller._id, {
    shippingOptions: { worldwide: false, nationalOnly: false, localPickup: true }
  });
  return { seller, buyerA, buyerB, product };
}

function openOrder(productId: unknown, buyerId: unknown) {
  return PayPalPaymentService.createDirectPayment(String(productId), String(buyerId), LOCAL_PICKUP);
}

function mockSuccessfulCapture() {
  return jest.spyOn(PayPalService, 'captureConnectedPayment').mockResolvedValue({
    status: 'COMPLETED', captureId: 'CAP-1', amount: '20.00', currency: 'EUR'
  });
}

describe('anti double-vente (integration)', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 60000);

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  beforeEach(async () => {
    await clearAllCollections();
    jest.restoreAllMocks();
    mockedPost.mockReset();
    mockedPost.mockImplementation(async () => {
      orderCounter += 1;
      return { data: { id: `ORDER-${orderCounter}`, links: [{ rel: 'payer-action', href: 'https://paypal.test/approve' }] } };
    });
    jest.spyOn(PayPalPartnerService, 'assertSellerCanTransact').mockResolvedValue(null as never);
  });

  describe('createDirectPayment', () => {
    it('crée le paiement sans bloquer le produit pour les autres acheteurs', async () => {
      const { buyerA, buyerB, product } = await setupSale();

      const first = await openOrder(product._id, buyerA._id);
      const second = await openOrder(product._id, buyerB._id);

      expect(first.orderId).not.toBe(second.orderId);
      expect(await Product.findById(product._id)).toMatchObject({ isAvailable: true, isSold: false });
    });

    it('refuse (409) un produit déjà vendu, sans créer d\'ordre PayPal', async () => {
      const { buyerA, product } = await setupSale();
      await Product.updateOne({ _id: product._id }, { isSold: true, isAvailable: false });

      await expect(openOrder(product._id, buyerA._id)).rejects.toMatchObject({ statusCode: 409 });
      expect(mockedPost).not.toHaveBeenCalled();
    });

    it('refuse (409) un produit retiré de la vente', async () => {
      const { buyerA, product } = await setupSale();
      await Product.updateOne({ _id: product._id }, { isAvailable: false });

      await expect(openOrder(product._id, buyerA._id)).rejects.toMatchObject({ statusCode: 409 });
    });
  });

  describe('captureDirectPayment', () => {
    it('encaisse et marque le produit vendu à l\'acheteur', async () => {
      const { buyerA, product } = await setupSale();
      const { orderId } = await openOrder(product._id, buyerA._id);
      mockSuccessfulCapture();

      await captureDirectPayment(String(buyerA._id), orderId);

      const sold = await Product.findById(product._id);
      expect(sold?.isSold).toBe(true);
      expect(String(sold?.soldTo)).toBe(String(buyerA._id));
      expect((await Payment.findOne({ paymentIntentId: orderId }))?.status).toBe('completed');
    });

    it('remet le produit en vente si la capture PayPal échoue', async () => {
      const { buyerA, product } = await setupSale();
      const { orderId } = await openOrder(product._id, buyerA._id);
      jest.spyOn(PayPalService, 'captureConnectedPayment').mockRejectedValue(new Error('ORDER_NOT_APPROVED'));

      await expect(captureDirectPayment(String(buyerA._id), orderId)).rejects.toThrow('ORDER_NOT_APPROVED');

      const released = await Product.findById(product._id);
      expect(released).toMatchObject({ isSold: false, isAvailable: true });
      expect(released?.soldTo).toBeUndefined();
      expect((await Payment.findOne({ paymentIntentId: orderId }))?.status).toBe('pending');
    });

    it('refuse (409) le second acheteur une fois le produit vendu, sans rien encaisser', async () => {
      const { buyerA, buyerB, product } = await setupSale();
      const orderA = await openOrder(product._id, buyerA._id);
      const orderB = await openOrder(product._id, buyerB._id);
      const capture = mockSuccessfulCapture();
      await captureDirectPayment(String(buyerA._id), orderA.orderId);
      capture.mockClear();

      await expect(captureDirectPayment(String(buyerB._id), orderB.orderId)).rejects.toMatchObject({ statusCode: 409 });

      expect(capture).not.toHaveBeenCalled();
      expect(String((await Product.findById(product._id))?.soldTo)).toBe(String(buyerA._id));
    });

    it('n\'encaisse qu\'un acheteur sur deux captures simultanées', async () => {
      const { buyerA, buyerB, product } = await setupSale();
      const orderA = await openOrder(product._id, buyerA._id);
      const orderB = await openOrder(product._id, buyerB._id);
      const capture = mockSuccessfulCapture();

      const results = await Promise.allSettled([
        captureDirectPayment(String(buyerA._id), orderA.orderId),
        captureDirectPayment(String(buyerB._id), orderB.orderId)
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(capture).toHaveBeenCalledTimes(1);
    });

    it('refuse (409) d\'encaisser si le vendeur a retiré l\'annonce entre temps', async () => {
      const { buyerA, product } = await setupSale();
      const { orderId } = await openOrder(product._id, buyerA._id);
      await Product.updateOne({ _id: product._id }, { isAvailable: false });
      const capture = mockSuccessfulCapture();

      await expect(captureDirectPayment(String(buyerA._id), orderId)).rejects.toMatchObject({ statusCode: 409 });

      expect(capture).not.toHaveBeenCalled();
      expect((await Product.findById(product._id))?.isSold).toBe(false);
    });
  });
});
