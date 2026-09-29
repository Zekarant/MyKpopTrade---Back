jest.mock('axios');
jest.mock('../../../notifications/services/notificationService', () => ({
  NotificationService: { createNotification: jest.fn().mockResolvedValue(undefined) }
}));
jest.mock('../paypalClient', () => ({
  PayPalClient: {
    getAccessToken: jest.fn().mockResolvedValue('platform-token'),
    checkPaymentStatus: jest.fn().mockResolvedValue('COMPLETED')
  },
  paypalApiBaseUrl: 'https://paypal.test',
  partnerHeaders: () => ({}),
  extractDebugId: () => undefined
}));

import axios from 'axios';
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
 * Ces tests verrouillent l'anti double-vente : un produit ne peut être réservé
 * que par un acheteur à la fois, et n'est encaissé qu'une fois.
 */

const mockedPost = axios.post as jest.Mock;
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

describe('réservation et encaissement atomiques (integration)', () => {
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
    it('réserve le produit pour l\'acheteur et crée le paiement', async () => {
      const { buyerA, product } = await setupSale();

      const result = await PayPalPaymentService.createDirectPayment(String(product._id), String(buyerA._id), LOCAL_PICKUP);

      const reserved = await Product.findById(product._id);
      expect(result.orderId).toMatch(/^ORDER-/);
      expect(reserved?.isReserved).toBe(true);
      expect(String(reserved?.reservedFor)).toBe(String(buyerA._id));
    });

    it('refuse (409) un second acheteur tant que le produit est réservé, sans créer d\'ordre PayPal', async () => {
      const { buyerA, buyerB, product } = await setupSale();
      await PayPalPaymentService.createDirectPayment(String(product._id), String(buyerA._id), LOCAL_PICKUP);

      await expect(
        PayPalPaymentService.createDirectPayment(String(product._id), String(buyerB._id), LOCAL_PICKUP)
      ).rejects.toMatchObject({ statusCode: 409 });

      expect(mockedPost).toHaveBeenCalledTimes(1);
      expect(String((await Product.findById(product._id))?.reservedFor)).toBe(String(buyerA._id));
    });

    it('ne laisse passer qu\'un acheteur sur deux demandes simultanées', async () => {
      const { buyerA, buyerB, product } = await setupSale();

      const results = await Promise.allSettled([
        PayPalPaymentService.createDirectPayment(String(product._id), String(buyerA._id), LOCAL_PICKUP),
        PayPalPaymentService.createDirectPayment(String(product._id), String(buyerB._id), LOCAL_PICKUP)
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await Payment.countDocuments({ product: product._id })).toBe(1);
    });

    it('libère la réservation si PayPal refuse de créer l\'ordre', async () => {
      const { buyerA, buyerB, product } = await setupSale();
      mockedPost.mockRejectedValueOnce(new Error('PayPal indisponible'));

      await expect(
        PayPalPaymentService.createDirectPayment(String(product._id), String(buyerA._id), LOCAL_PICKUP)
      ).rejects.toThrow('PayPal indisponible');

      expect((await Product.findById(product._id))?.isReserved).toBe(false);
      await expect(
        PayPalPaymentService.createDirectPayment(String(product._id), String(buyerB._id), LOCAL_PICKUP)
      ).resolves.toBeTruthy();
    });

    it('refuse un produit déjà vendu', async () => {
      const { buyerA, product } = await setupSale();
      await Product.updateOne({ _id: product._id }, { isSold: true, isAvailable: false });

      await expect(
        PayPalPaymentService.createDirectPayment(String(product._id), String(buyerA._id), LOCAL_PICKUP)
      ).rejects.toMatchObject({ statusCode: 409 });
    });
  });

  describe('captureDirectPayment', () => {
    it('encaisse et marque le produit vendu à l\'acheteur', async () => {
      const { buyerA, product } = await setupSale();
      const { orderId } = await PayPalPaymentService.createDirectPayment(String(product._id), String(buyerA._id), LOCAL_PICKUP);
      jest.spyOn(PayPalService, 'captureConnectedPayment').mockResolvedValue({
        status: 'COMPLETED', captureId: 'CAP-1', amount: '20.00', currency: 'EUR'
      });

      await captureDirectPayment(String(buyerA._id), orderId);

      const sold = await Product.findById(product._id);
      expect(sold?.isSold).toBe(true);
      expect(String(sold?.soldTo)).toBe(String(buyerA._id));
      expect((await Payment.findOne({ paymentIntentId: orderId }))?.status).toBe('completed');
    });

    it('remet le produit en vente si la capture PayPal échoue', async () => {
      const { buyerA, product } = await setupSale();
      const { orderId } = await PayPalPaymentService.createDirectPayment(String(product._id), String(buyerA._id), LOCAL_PICKUP);
      jest.spyOn(PayPalService, 'captureConnectedPayment').mockRejectedValue(new Error('ORDER_NOT_APPROVED'));

      await expect(captureDirectPayment(String(buyerA._id), orderId)).rejects.toThrow('ORDER_NOT_APPROVED');

      const product2 = await Product.findById(product._id);
      expect(product2?.isSold).toBe(false);
      expect(product2?.soldTo).toBeUndefined();
      expect((await Payment.findOne({ paymentIntentId: orderId }))?.status).toBe('pending');
    });

    it('refuse (409) d\'encaisser si le produit est désormais réservé pour un autre acheteur', async () => {
      const { buyerA, buyerB, product } = await setupSale();
      const { orderId } = await PayPalPaymentService.createDirectPayment(String(product._id), String(buyerA._id), LOCAL_PICKUP);
      await Product.updateOne({ _id: product._id }, { reservedFor: buyerB._id });
      const capture = jest.spyOn(PayPalService, 'captureConnectedPayment');

      await expect(captureDirectPayment(String(buyerA._id), orderId)).rejects.toMatchObject({ statusCode: 409 });

      expect(capture).not.toHaveBeenCalled();
      expect((await Product.findById(product._id))?.isSold).toBe(false);
    });
  });
});
