import {
  startInMemoryMongo,
  stopInMemoryMongo,
  clearAllCollections
} from '../../../../tests/helpers/mongoMemory';
import { createTestProduct, createTestUser } from '../../../../tests/helpers/fixtures';
import Payment from '../../../../models/paymentModel';
import { forEachPaymentBatch } from '../paymentBatches';

async function createPayments(count: number, status: 'pending' | 'completed' = 'completed') {
  const seller = await createTestUser();
  const buyer = await createTestUser();
  const product = await createTestProduct(seller._id);
  const docs = Array.from({ length: count }, (_, index) => ({
    product: product._id,
    buyer: buyer._id,
    seller: seller._id,
    amount: 20,
    currency: 'EUR',
    paymentIntentId: `order-batch-${status}-${index}`,
    status,
    paymentMethod: 'paypal',
    paymentType: 'direct'
  }));
  return Payment.insertMany(docs);
}

describe('forEachPaymentBatch (integration)', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 60000);

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  beforeEach(async () => {
    await clearAllCollections();
  });

  it('parcourt tous les paiements du filtre, par lots bornés, chacun une seule fois', async () => {
    const created = await createPayments(5);
    await createPayments(2, 'pending');
    const batchSizes: number[] = [];
    const seen: string[] = [];

    await forEachPaymentBatch({ status: 'completed' }, async (batch) => {
      batchSizes.push(batch.length);
      seen.push(...batch.map((payment) => payment._id.toString()));
    }, { batchSize: 2 });

    expect(batchSizes).toEqual([2, 2, 1]);
    expect(seen.sort()).toEqual(created.map((payment) => payment._id.toString()).sort());
  });

  it('ne revoit pas un paiement que le traitement a sorti du filtre', async () => {
    await createPayments(4);
    let visits = 0;

    await forEachPaymentBatch({ status: 'completed' }, async (batch) => {
      visits += batch.length;
      await Payment.updateMany({ _id: { $in: batch.map((payment) => payment._id) } }, { status: 'refunded' });
    }, { batchSize: 2 });

    expect(visits).toBe(4);
  });
});
