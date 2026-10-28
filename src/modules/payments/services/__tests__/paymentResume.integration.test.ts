jest.mock('../paypalClient', () => ({
  PayPalClient: {
    getAccessToken: jest.fn().mockResolvedValue('platform-token'),
    checkPaymentStatus: jest.fn().mockResolvedValue('CREATED')
  },
  paypalHttp: { get: jest.fn(), post: jest.fn() },
  partnerHeaders: () => ({}),
  extractDebugId: () => undefined
}));

import { paypalHttp } from '../paypalClient';
import { Types } from 'mongoose';
import {
  startInMemoryMongo,
  stopInMemoryMongo,
  clearAllCollections
} from '../../../../tests/helpers/mongoMemory';
import { createTestUser, createTestProduct } from '../../../../tests/helpers/fixtures';
import Payment from '../../../../models/paymentModel';
import Product from '../../../../models/productModel';
import { PayPalPaymentService } from '../paypalPaymentService';
import { PayPalPartnerService } from '../paypalPartnerService';

const mockedPost = paypalHttp.post as jest.Mock;
const mockedGet = paypalHttp.get as jest.Mock;
const PICKUP = { shippingOptions: { worldwide: false, nationalOnly: false, localPickup: true } };

describe('reprise d\'un paiement PayPal en attente (integration)', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 60000);

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  beforeEach(async () => {
    await clearAllCollections();
    jest.restoreAllMocks();
    let orderCounter = 0;
    mockedPost.mockReset();
    mockedPost.mockImplementation(async () => {
      orderCounter += 1;
      return { data: { id: `ORDER-${orderCounter}`, links: [{ rel: 'payer-action', href: `https://paypal.test/${orderCounter}` }] } };
    });
    mockedGet.mockReset();
    mockedGet.mockResolvedValue({ data: { links: [{ rel: 'approve', href: 'https://paypal.test/approve' }] } });
    jest.spyOn(PayPalPartnerService, 'assertSellerCanTransact').mockResolvedValue(null as never);
  });

  async function setup() {
    const buyer = await createTestUser();
    const seller = await createTestUser({ paypalConnected: true, paypalMerchantId: 'MERCHANT-RESUME' });
    const product = await createTestProduct(seller._id, { ...PICKUP, price: 20 });
    return { buyerId: buyer._id.toString(), buyer, product };
  }

  it('reprend l\'ordre en attente quand la commande est identique', async () => {
    const { buyerId, product } = await setup();

    const first = await PayPalPaymentService.createDirectPayment(product._id.toString(), buyerId, { shippingMethod: 'localPickup' });
    const second = await PayPalPaymentService.createDirectPayment(product._id.toString(), buyerId, { shippingMethod: 'localPickup' });

    expect(second).toMatchObject({ orderId: first.orderId, resumed: true });
    expect(mockedPost).toHaveBeenCalledTimes(1);
  });

  it('crée un nouvel ordre au prix négocié accepté après le premier', async () => {
    const { buyerId, buyer, product } = await setup();
    const first = await PayPalPaymentService.createDirectPayment(product._id.toString(), buyerId, { shippingMethod: 'localPickup' });
    await Product.updateOne({ _id: product._id }, {
      $push: {
        negotiations: {
          buyer: buyer._id,
          initialOffer: 15,
          currentOffer: 15,
          status: 'accepted',
          conversationId: new Types.ObjectId(),
          createdAt: new Date(),
          updatedAt: new Date()
        }
      }
    });

    const second = await PayPalPaymentService.createDirectPayment(product._id.toString(), buyerId, { shippingMethod: 'localPickup' });

    expect(second.orderId).not.toBe(first.orderId);
    expect(second.amount).toBe(15);
    expect((await Payment.findById(first.paymentId))?.status).toBe('cancelled');
  });
});
