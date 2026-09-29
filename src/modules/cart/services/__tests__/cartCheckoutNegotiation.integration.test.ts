jest.mock('axios');
jest.mock('../../../notifications/services/notificationService', () => ({
  NotificationService: { createNotification: jest.fn().mockResolvedValue(undefined) }
}));
jest.mock('../../../payments/services/paypalClient', () => ({
  PayPalClient: {
    getAccessToken: jest.fn().mockResolvedValue('platform-token'),
    checkPaymentStatus: jest.fn().mockResolvedValue('CREATED')
  },
  paypalApiBaseUrl: 'https://paypal.test',
  partnerHeaders: () => ({}),
  extractDebugId: () => undefined
}));

import axios from 'axios';
import { Types } from 'mongoose';
import {
  startInMemoryMongo,
  stopInMemoryMongo,
  clearAllCollections
} from '../../../../tests/helpers/mongoMemory';
import { createTestUser, createTestProduct } from '../../../../tests/helpers/fixtures';
import * as cartService from '../cartService';
import { checkoutCart } from '../cartCheckoutService';
import { PayPalPartnerService } from '../../../payments/services/paypalPartnerService';

/**
 * Le panier passe par le vrai createDirectPayment (seul PayPal est simulé) :
 * le montant envoyé à PayPal doit être le prix négocié, et égal au
 * `buyerPrice` que le panier affiche.
 */
const mockedPost = axios.post as jest.Mock;

type PostedOrder = { purchase_units: Array<{ custom_id: string; amount: { value: string } }> };

function postedAmountFor(productId: string): string | undefined {
  return mockedPost.mock.calls
    .map(([, body]) => (body as PostedOrder).purchase_units[0])
    .find((unit) => unit.custom_id === productId)?.amount.value;
}

describe('checkoutCart et négociations (integration)', () => {
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
    jest.spyOn(PayPalPartnerService, 'assertSellerCanTransact').mockResolvedValue(null as never);
  });

  it('facture le prix négocié accepté, et le prix catalogue pour les autres articles', async () => {
    const buyer = await createTestUser();
    const other = await createTestUser();
    const seller = await createTestUser({ paypalConnected: true, paypalMerchantId: 'MERCHANT-NEGO' });
    const pickup = { shippingOptions: { worldwide: false, nationalOnly: false, localPickup: true } };
    const accepted = (buyerId: Types.ObjectId, currentOffer: number) => ({
      buyer: buyerId,
      initialOffer: currentOffer,
      currentOffer,
      status: 'accepted' as const,
      conversationId: new Types.ObjectId(),
      createdAt: new Date(),
      updatedAt: new Date()
    });
    const negotiated = await createTestProduct(seller._id, {
      ...pickup,
      title: 'Négocié',
      price: 20,
      negotiations: [accepted(other._id, 9), accepted(buyer._id, 15)]
    });
    const catalogue = await createTestProduct(seller._id, { ...pickup, title: 'Catalogue', price: 8 });
    const buyerId = buyer._id.toString();
    await cartService.addItem(buyerId, negotiated._id.toString());
    await cartService.addItem(buyerId, catalogue._id.toString());

    const cart = await cartService.getCart(buyerId);
    const results = await checkoutCart(buyerId, { shippingMethod: 'localPickup' });

    const amountOf = (productId: string) => results.find((r) => r.productIds[0] === productId)?.amount;
    expect(amountOf(negotiated._id.toString())).toBe(15);
    expect(amountOf(catalogue._id.toString())).toBe(8);
    expect(postedAmountFor(negotiated._id.toString())).toBe('15.00');
    expect(postedAmountFor(catalogue._id.toString())).toBe('8.00');
    expect(cart.items.map((item) => item.buyerPrice)).toEqual([15, 8]);
    expect(results.every((r) => /^ORDER-/.test(r.paypalOrderId))).toBe(true);
  });
});
