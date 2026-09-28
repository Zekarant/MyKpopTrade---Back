import {
  startInMemoryMongo,
  stopInMemoryMongo,
  clearAllCollections
} from '../../../../tests/helpers/mongoMemory';
import { createTestProduct, createTestUser } from '../../../../tests/helpers/fixtures';
import Payment from '../../../../models/paymentModel';
import { anonymizeBuyerPayments, anonymizeExpiredPayments } from '../paymentAnonymizationService';

const ADDRESS = {
  recipientName: 'Alice Martin',
  streetLine1: '12 rue des Lilas',
  postalCode: '69001',
  city: 'Lyon',
  country: 'FR',
  phone: '+33612345678'
};

const DELIVERED_SHIPMENT = {
  carrier: 'colissimo',
  trackingNumber: 'X1',
  status: 'delivered',
  shippedAt: new Date(),
  events: [{ status: 'delivered', location: 'Lyon 1er', occurredAt: new Date(), source: 'carrier' }]
};

async function createPayment(overrides: Record<string, unknown> = {}) {
  const seller = await createTestUser();
  const buyer = await createTestUser();
  const product = await createTestProduct(seller._id);
  return Payment.create({
    product: product._id,
    buyer: buyer._id,
    seller: seller._id,
    amount: 20,
    currency: 'EUR',
    paymentIntentId: `order-${Math.random()}`,
    status: 'completed',
    paymentMethod: 'paypal',
    paymentType: 'direct',
    ipAddress: '203.0.113.7',
    userAgent: 'Firefox',
    shippingAddress: ADDRESS,
    ...overrides
  });
}

describe('paymentAnonymizationService (integration)', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 60000);

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  beforeEach(async () => {
    await clearAllCollections();
  });

  describe('anonymizeExpiredPayments', () => {
    it('efface adresse, téléphone, IP et lieux de suivi d\'un paiement de plus de 3 ans', async () => {
      const payment = await createPayment({ shipment: DELIVERED_SHIPMENT });
      const fourYearsLater = new Date(Date.now() + 4 * 365 * 24 * 3600 * 1000);

      const count = await anonymizeExpiredPayments(fourYearsLater);

      const saved = await Payment.findById(payment._id).select('+ipAddress +userAgent').lean<any>();
      expect(count).toBe(1);
      expect(saved.shippingAddress).toBeUndefined();
      expect(saved.ipAddress).toBe('0.0.0.0');
      expect(saved.shipment.events[0].location).toBeUndefined();
      expect(saved.anonymized).toBe(true);
      expect(saved.amount).toBe(20);
    });

    it('ne touche pas un paiement récent', async () => {
      const payment = await createPayment();

      expect(await anonymizeExpiredPayments()).toBe(0);
      expect((await Payment.findById(payment._id).lean<any>()).shippingAddress.city).toBe('Lyon');
    });
  });

  describe('anonymizeBuyerPayments', () => {
    it('anonymise une commande livrée mais garde l\'adresse d\'une commande à expédier', async () => {
      const delivered = await createPayment({ shipment: DELIVERED_SHIPMENT });
      const toShip = await createPayment({ buyer: delivered.buyer });

      const count = await anonymizeBuyerPayments(String(delivered.buyer));

      expect(count).toBe(1);
      expect((await Payment.findById(delivered._id).lean<any>()).shippingAddress).toBeUndefined();
      expect((await Payment.findById(toShip._id).lean<any>()).shippingAddress.city).toBe('Lyon');
    });
  });
});
