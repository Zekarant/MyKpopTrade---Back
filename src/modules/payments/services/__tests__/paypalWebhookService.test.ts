import { PayPalWebhookService } from '../paypalWebhookService';
import Payment from '../../../../models/paymentModel';
import Product from '../../../../models/productModel';
import { NotificationService } from '../../../notifications/services/notificationService';
import { dispatchAdminAlert } from '../../../../commons/services/adminAlertService';
import { completePayment } from '../paymentCompletion';

jest.mock('../../../../models/paymentModel');
jest.mock('../../../../models/productModel');
jest.mock('../../../../models/userModel');
jest.mock('../../../notifications/services/notificationService');
jest.mock('../../../../commons/services/adminAlertService');
jest.mock('../paymentCompletion');

const mockedPayment = Payment as jest.Mocked<typeof Payment>;

function fakePayment(overrides: { status?: string; captureId?: string; amount?: number } = {}) {
  return {
    _id: 'pay1',
    product: 'prod1',
    buyer: 'buyer1',
    seller: 'seller1',
    amount: 27,
    currency: 'EUR',
    status: 'pending',
    captureId: undefined,
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides
  };
}

const ORDER_ID = '8PS98668HM5316634';
const CAPTURE_ID = '8X2960533G640564N';

/** Événement PAYPAL.CAPTURE.COMPLETED tel que PayPal l'émet réellement. */
function captureCompletedEvent() {
  return {
    event_type: 'PAYMENT.CAPTURE.COMPLETED',
    resource: {
      // `id` est celui de la CAPTURE, pas de l'ordre.
      id: CAPTURE_ID,
      amount: { value: '27.00', currency_code: 'EUR' },
      supplementary_data: { related_ids: { order_id: ORDER_ID } }
    }
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  (Product.findByIdAndUpdate as jest.Mock).mockResolvedValue(undefined);
  (NotificationService.createNotification as jest.Mock).mockResolvedValue(undefined);
  (completePayment as jest.Mock).mockResolvedValue('completed');
});

describe('PAYMENT.CAPTURE.COMPLETED', () => {
  it('retrouve le paiement par l\'orderId, pas par l\'id de la capture', async () => {
    const payment = fakePayment();
    (mockedPayment.findOne as jest.Mock).mockResolvedValue(payment);

    await PayPalWebhookService.handleWebhook(captureCompletedEvent());

    expect(mockedPayment.findOne).toHaveBeenCalledWith({ paymentIntentId: ORDER_ID });
  });

  it('finalise le paiement avec le captureId — sans lui aucun remboursement n\'est possible', async () => {
    const payment = fakePayment();
    (mockedPayment.findOne as jest.Mock).mockResolvedValue(payment);

    await PayPalWebhookService.handleWebhook(captureCompletedEvent());

    expect(completePayment).toHaveBeenCalledWith('pay1', CAPTURE_ID);
  });

  it.each([
    ['un montant différent', { value: '20.00', currency_code: 'EUR' }],
    ['une autre devise', { value: '27.00', currency_code: 'USD' }],
    ['aucun montant', undefined]
  ])('ne finalise pas une capture portant %s, et alerte un admin', async (_label, amount) => {
    const payment = fakePayment();
    (mockedPayment.findOne as jest.Mock).mockResolvedValue(payment);
    const event = captureCompletedEvent();

    await PayPalWebhookService.handleWebhook({ ...event, resource: { ...event.resource, amount } });

    expect(completePayment).not.toHaveBeenCalled();
    expect(dispatchAdminAlert).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'payment.capture_amount_mismatch', severity: 'critical' })
    );
  });

  it('accepte un montant capturé égal à la commande malgré l\'écriture décimale', async () => {
    (mockedPayment.findOne as jest.Mock).mockResolvedValue(fakePayment({ amount: 27.5 }));
    const event = captureCompletedEvent();

    await PayPalWebhookService.handleWebhook({
      ...event,
      resource: { ...event.resource, amount: { value: '27.50', currency_code: 'EUR' } }
    });

    expect(completePayment).toHaveBeenCalled();
  });
});

describe('CHECKOUT.ORDER.APPROVED', () => {
  it('ne marque pas le paiement comme encaissé : l\'acheteur a approuvé, rien n\'a bougé', async () => {
    const payment = fakePayment();
    (mockedPayment.findOne as jest.Mock).mockResolvedValue(payment);

    await PayPalWebhookService.handleWebhook({
      event_type: 'CHECKOUT.ORDER.APPROVED',
      resource: { id: ORDER_ID }
    });

    expect(payment.status).toBe('pending');
    expect(payment.save).not.toHaveBeenCalled();
    expect(Product.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(NotificationService.createNotification).not.toHaveBeenCalled();
  });
});

describe('PAYMENT.CAPTURE.DENIED', () => {
  it('annule la vente faite à cet acheteur pour remettre le produit en vente', async () => {
    const payment = fakePayment({ status: 'completed' });
    (mockedPayment.findOne as jest.Mock).mockResolvedValue(payment);
    (Product.updateOne as jest.Mock).mockResolvedValue(undefined);

    await PayPalWebhookService.handleWebhook({
      event_type: 'PAYMENT.CAPTURE.DENIED',
      resource: { id: CAPTURE_ID, supplementary_data: { related_ids: { order_id: ORDER_ID } } }
    });

    expect(payment.status).toBe('failed');
    expect(Product.updateOne).toHaveBeenCalledWith(
      { _id: 'prod1', soldTo: 'buyer1' },
      { $set: { isAvailable: true, isSold: false }, $unset: { soldAt: 1, soldTo: 1 } }
    );
  });
});
