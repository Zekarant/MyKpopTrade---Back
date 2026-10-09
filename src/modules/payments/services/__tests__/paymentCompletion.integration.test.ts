jest.mock('../../../notifications/services/notificationService', () => ({
  NotificationService: { createNotification: jest.fn().mockResolvedValue(undefined) }
}));
jest.mock('../../../../commons/services/adminAlertService', () => ({
  dispatchAdminAlert: jest.fn()
}));

import { Types } from 'mongoose';
import {
  startInMemoryMongo,
  stopInMemoryMongo,
  clearAllCollections
} from '../../../../tests/helpers/mongoMemory';
import { createTestProduct, createTestUser } from '../../../../tests/helpers/fixtures';
import Payment from '../../../../models/paymentModel';
import Product from '../../../../models/productModel';
import { NotificationService } from '../../../notifications/services/notificationService';
import { dispatchAdminAlert } from '../../../../commons/services/adminAlertService';
import { PayPalService } from '../paypalService';
import { PayPalWebhookService } from '../paypalWebhookService';
import { OrderNotApprovedError } from '../paypalPaymentService';
import { captureDirectPayment } from '../paymentService';
import { completePayment } from '../paymentCompletion';

/**
 * La capture synchrone et le webhook PAYMENT.CAPTURE.COMPLETED finalisent le
 * même paiement, souvent à quelques millisecondes d'écart : un seul des deux
 * doit vendre le produit et prévenir le vendeur.
 */

const ORDER_ID = 'ORDER-COMPLETION';
const CAPTURE_ID = 'CAP-COMPLETION';

async function setupPendingPayment() {
  const seller = await createTestUser({ paypalMerchantId: 'MERCHANT-COMPLETION' });
  const buyer = await createTestUser();
  const product = await createTestProduct(seller._id);
  const payment = await Payment.create({
    product: product._id,
    buyer: buyer._id,
    seller: seller._id,
    amount: 20,
    currency: 'EUR',
    paymentIntentId: ORDER_ID,
    approvalUrl: 'https://paypal.test/approve/completion',
    status: 'pending',
    paymentMethod: 'paypal',
    paymentType: 'direct'
  });
  return { seller, buyer, product, payment };
}

function captureCompletedEvent(value = '20.00') {
  return {
    event_type: 'PAYMENT.CAPTURE.COMPLETED',
    resource: {
      id: CAPTURE_ID,
      amount: { value, currency_code: 'EUR' },
      supplementary_data: { related_ids: { order_id: ORDER_ID } }
    }
  };
}

describe('finalisation d\'un paiement (integration)', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 60000);

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  beforeEach(async () => {
    await clearAllCollections();
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it('capture puis webhook : une seule finalisation, un seul avis au vendeur', async () => {
    const { buyer, product, payment } = await setupPendingPayment();
    jest.spyOn(PayPalService, 'captureConnectedPayment').mockResolvedValue({
      status: 'COMPLETED', captureId: CAPTURE_ID, amount: '20.00', currency: 'EUR'
    });

    await captureDirectPayment(String(buyer._id), ORDER_ID);
    const soldAt = (await Product.findById(product._id))?.soldAt;
    await PayPalWebhookService.handleWebhook(captureCompletedEvent());

    const completed = await Payment.findById(payment._id);
    const sold = await Product.findById(product._id);
    expect(completed).toMatchObject({ status: 'completed', captureId: CAPTURE_ID });
    expect(String(sold?.soldTo)).toBe(String(buyer._id));
    expect(sold?.soldAt).toEqual(soldAt);
    // Une seule annonce : vendeur + acheteur.
    expect(NotificationService.createNotification).toHaveBeenCalledTimes(2);
  });

  it('deux finalisations simultanées : une seule fait la transition', async () => {
    const { payment } = await setupPendingPayment();

    const outcomes = await Promise.all([
      completePayment(payment._id, CAPTURE_ID),
      completePayment(payment._id, CAPTURE_ID)
    ]);

    expect(outcomes.sort()).toEqual(['already_completed', 'completed']);
    // Une seule annonce : vendeur + acheteur.
    expect(NotificationService.createNotification).toHaveBeenCalledTimes(2);
  });

  it('webhook seul : finalise le paiement et vend le produit à l\'acheteur', async () => {
    const { buyer, product, payment } = await setupPendingPayment();

    await PayPalWebhookService.handleWebhook(captureCompletedEvent());

    expect(await Payment.findById(payment._id)).toMatchObject({ status: 'completed', captureId: CAPTURE_ID });
    expect(await Product.findById(product._id)).toMatchObject({ isSold: true, isAvailable: false });
    expect(String((await Product.findById(product._id))?.soldTo)).toBe(String(buyer._id));
  });

  it('webhook dont le montant diffère : le paiement reste en attente et le produit en vente', async () => {
    const { product, payment } = await setupPendingPayment();

    await PayPalWebhookService.handleWebhook(captureCompletedEvent('2.00'));

    expect((await Payment.findById(payment._id))?.status).toBe('pending');
    expect((await Product.findById(product._id))?.isSold).toBe(false);
    expect(dispatchAdminAlert).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'payment.capture_amount_mismatch' })
    );
  });

  it('enregistre le captureId sur un paiement déjà finalisé sans rejouer la vente', async () => {
    const { payment } = await setupPendingPayment();
    await completePayment(payment._id);
    jest.clearAllMocks();

    const outcome = await completePayment(payment._id, CAPTURE_ID);

    expect(outcome).toBe('already_completed');
    expect((await Payment.findById(payment._id))?.captureId).toBe(CAPTURE_ID);
    expect(NotificationService.createNotification).not.toHaveBeenCalled();
  });

  it('ne ramène pas à « completed » un paiement remboursé (webhook redélivré)', async () => {
    const { payment } = await setupPendingPayment();
    await Payment.updateOne({ _id: payment._id }, { status: 'refunded' });

    expect(await completePayment(payment._id, CAPTURE_ID)).toBe('already_completed');
    expect((await Payment.findById(payment._id))?.status).toBe('refunded');
  });

  it('produit déjà vendu à un autre acheteur : ne le revend pas et alerte un admin', async () => {
    const { product, payment } = await setupPendingPayment();
    const otherBuyer = new Types.ObjectId();
    await Product.updateOne({ _id: product._id }, { isSold: true, isAvailable: false, soldTo: otherBuyer });

    const outcome = await completePayment(payment._id, CAPTURE_ID);

    expect(outcome).toBe('product_conflict');
    expect(String((await Product.findById(product._id))?.soldTo)).toBe(String(otherBuyer));
    // L'argent a bougé : le paiement est finalisé pour pouvoir être remboursé.
    expect((await Payment.findById(payment._id))?.status).toBe('completed');
    expect(dispatchAdminAlert).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'payment.product_already_sold', severity: 'critical' })
    );
    expect(NotificationService.createNotification).not.toHaveBeenCalled();
  });

  it('capture d\'un ordre non approuvé : 400 ORDER_NOT_APPROVED avec l\'URL d\'approbation, produit remis en vente', async () => {
    const { buyer, product } = await setupPendingPayment();
    jest.spyOn(PayPalService, 'captureConnectedPayment').mockRejectedValue(new OrderNotApprovedError(ORDER_ID));

    await expect(captureDirectPayment(String(buyer._id), ORDER_ID)).rejects.toMatchObject({
      statusCode: 400,
      code: 'ORDER_NOT_APPROVED',
      details: { approvalUrl: 'https://paypal.test/approve/completion' }
    });
    expect((await Product.findById(product._id))?.isSold).toBe(false);
  });
});
