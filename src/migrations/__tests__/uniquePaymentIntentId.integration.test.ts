import {
  startInMemoryMongo,
  stopInMemoryMongo,
  clearAllCollections
} from '../../tests/helpers/mongoMemory';
import { createTestProduct, createTestUser } from '../../tests/helpers/fixtures';
import Payment from '../../models/paymentModel';
import { PAYMENT_INTENT_INDEX_NAME, makePaymentIntentIdUnique } from '../0004-uniquePaymentIntentId';

/** Un ordre PayPal ↔ un paiement : l'index simple devient unique, sauf doublons existants. */
async function aPayment(paymentIntentId?: string) {
  const [buyer, seller] = [await createTestUser(), await createTestUser()];
  const product = await createTestProduct(seller._id);
  return Payment.collection.insertOne({
    product: product._id, buyer: buyer._id, seller: seller._id,
    amount: 20, currency: 'EUR', status: 'pending', createdAt: new Date(),
    ...(paymentIntentId ? { paymentIntentId } : {})
  });
}

/** État d'une base déployée avant la migration : index simple, sans unicité. */
async function legacyIndexOnly() {
  await Payment.collection.dropIndexes();
  await Payment.collection.createIndex({ paymentIntentId: 1 }, { name: PAYMENT_INTENT_INDEX_NAME });
}

const paymentIntentIndex = async () =>
  (await Payment.collection.indexes()).find((index) => index.name === PAYMENT_INTENT_INDEX_NAME);

describe('0004-uniquePaymentIntentId (integration)', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 60000);

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  beforeEach(async () => {
    await clearAllCollections();
    await Payment.createCollection();
  });

  it('remplace l\'index simple par un index unique, et refuse ensuite un doublon', async () => {
    await legacyIndexOnly();
    await aPayment('ORDER-1');

    await makePaymentIntentIdUnique();

    expect(await paymentIntentIndex()).toMatchObject({ unique: true });
    await expect(aPayment('ORDER-1')).rejects.toMatchObject({ code: 11000 });
  });

  it('laisse coexister les paiements sans ordre PayPal', async () => {
    await legacyIndexOnly();
    await makePaymentIntentIdUnique();

    await aPayment();
    await aPayment();

    expect(await Payment.countDocuments({ paymentIntentId: { $exists: false } })).toBe(2);
  });

  it('échoue en listant les ordres en double, sans toucher à l\'index', async () => {
    await legacyIndexOnly();
    await aPayment('ORDER-1');
    await aPayment('ORDER-1');

    await expect(makePaymentIntentIdUnique()).rejects.toThrow('ORDER-1');
    expect((await paymentIntentIndex())?.unique).toBeUndefined();
  });

  it('remplace un index unique non partiel, qui refuserait plusieurs paiements sans ordre', async () => {
    await Payment.collection.dropIndexes();
    await Payment.collection.createIndex({ paymentIntentId: 1 }, { name: PAYMENT_INTENT_INDEX_NAME, unique: true, sparse: true });

    await makePaymentIntentIdUnique();

    expect(await paymentIntentIndex()).toMatchObject({
      unique: true,
      partialFilterExpression: { paymentIntentId: { $type: 'string' } }
    });
  });

  it('ne fait rien quand l\'index est déjà unique (migration rejouée)', async () => {
    await legacyIndexOnly();
    await makePaymentIntentIdUnique();

    await expect(makePaymentIntentIdUnique()).resolves.toBeUndefined();
    expect(await paymentIntentIndex()).toMatchObject({ unique: true });
  });
});
