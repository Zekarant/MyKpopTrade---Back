import { PayPalWebhookService } from '../paypalWebhookService';
import Payment from '../../../../models/paymentModel';
import Product from '../../../../models/productModel';
import Conversation from '../../../../models/conversationModel';
import { NotificationService } from '../../../notifications/services/notificationService';

jest.mock('../../../../models/paymentModel');
jest.mock('../../../../models/productModel');
jest.mock('../../../../models/conversationModel');
jest.mock('../../../../models/messageModel');
jest.mock('../../../../models/userModel');
jest.mock('../../../notifications/services/notificationService');

const mockedPayment = Payment as jest.Mocked<typeof Payment>;

function fakePayment(overrides: any = {}) {
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
  (Conversation.findOne as jest.Mock).mockResolvedValue(null);
  (NotificationService.createNotification as jest.Mock).mockResolvedValue(undefined);
});

describe('PAYMENT.CAPTURE.COMPLETED', () => {
  it('retrouve le paiement par l\'orderId, pas par l\'id de la capture', async () => {
    const payment = fakePayment();
    (mockedPayment.findOne as jest.Mock).mockResolvedValue(payment);

    await PayPalWebhookService.handleWebhook(captureCompletedEvent());

    expect(mockedPayment.findOne).toHaveBeenCalledWith({ paymentIntentId: ORDER_ID });
  });

  it('enregistre le captureId — sans lui aucun remboursement n\'est possible', async () => {
    const payment = fakePayment();
    (mockedPayment.findOne as jest.Mock).mockResolvedValue(payment);

    await PayPalWebhookService.handleWebhook(captureCompletedEvent());

    expect(payment.captureId).toBe(CAPTURE_ID);
    expect(payment.status).toBe('completed');
  });

  it('enregistre le captureId même si le paiement est déjà completed', async () => {
    // Cas réel : la capture synchrone a déjà basculé le statut, puis le webhook
    // arrive. Sans ce rattrapage, le captureId reste vide définitivement.
    const payment = fakePayment({ status: 'completed' });
    (mockedPayment.findOne as jest.Mock).mockResolvedValue(payment);

    await PayPalWebhookService.handleWebhook(captureCompletedEvent());

    expect(payment.captureId).toBe(CAPTURE_ID);
    expect(payment.save).toHaveBeenCalled();
  });

  it('ne réécrit pas un captureId déjà à jour', async () => {
    const payment = fakePayment({ status: 'completed', captureId: CAPTURE_ID });
    (mockedPayment.findOne as jest.Mock).mockResolvedValue(payment);

    await PayPalWebhookService.handleWebhook(captureCompletedEvent());

    expect(payment.save).not.toHaveBeenCalled();
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
