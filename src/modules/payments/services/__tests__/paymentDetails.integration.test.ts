import {
  startInMemoryMongo,
  stopInMemoryMongo,
  clearAllCollections
} from '../../../../tests/helpers/mongoMemory';
import { createTestProduct, createTestUser } from '../../../../tests/helpers/fixtures';
import Payment from '../../../../models/paymentModel';
import User from '../../../../models/userModel';
import { fetchPaymentDetails } from '../paymentService';

async function createPayment() {
  const seller = await createTestUser();
  const buyer = await createTestUser();
  const product = await createTestProduct(seller._id);
  const payment = await Payment.create({
    product: product._id,
    buyer: buyer._id,
    seller: seller._id,
    amount: 20,
    currency: 'EUR',
    paymentIntentId: `order-${Math.random()}`,
    status: 'completed',
    paymentMethod: 'paypal',
    paymentType: 'direct'
  });
  return { seller, buyer, payment };
}

describe('fetchPaymentDetails (integration)', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 60000);

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  beforeEach(async () => {
    await clearAllCollections();
  });

  it('reste accessible au vendeur quand le compte de l\'acheteur n\'existe plus (répondait 500)', async () => {
    const { seller, buyer, payment } = await createPayment();
    await User.deleteOne({ _id: buyer._id });

    const details = await fetchPaymentDetails(seller._id.toString(), payment._id.toString());

    expect(details.buyer).toBeNull();
    expect(String(details.seller?._id)).toBe(seller._id.toString());
  });

  it('refuse un tiers', async () => {
    const { payment } = await createPayment();
    const stranger = await createTestUser();

    await expect(fetchPaymentDetails(stranger._id.toString(), payment._id.toString()))
      .rejects.toMatchObject({ statusCode: 403 });
  });
});
