import request from 'supertest';
import { createApp } from '../../app';
import { startInMemoryMongo, stopInMemoryMongo, clearAllCollections } from '../helpers/mongoMemory';
import { createTestProduct, createTestUser } from '../helpers/fixtures';
import { generateAccessToken } from '../../commons/services/tokenService';
import Payment from '../../models/paymentModel';
import Product from '../../models/productModel';
import User from '../../models/userModel';
import { PayPalClient, paypalHttp } from '../../modules/payments/services/paypalClient';
import { PayPalService } from '../../modules/payments/services/paypalService';
import { paymentConfig } from '../../config/paymentConfig';

/** Paiements : webhook PayPal, onboarding vendeur, statut du compte PayPal. */
const app = createApp();

const auth = (user: Awaited<ReturnType<typeof createTestUser>>) => `Bearer ${generateAccessToken(user)}`;

describe('HTTP — paiements', () => {
  beforeAll(async () => {
    paymentConfig.paypal.partnerMerchantId = 'PARTNER-1';
    await startInMemoryMongo();
  }, 60000);

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  beforeEach(async () => {
    await clearAllCollections();
    jest.restoreAllMocks();
    jest.spyOn(PayPalClient, 'getAccessToken').mockResolvedValue('platform-token');
  });

  describe('POST /api/payments/webhook/paypal', () => {
    const postWebhook = (event: unknown) => request(app).post('/api/payments/webhook/paypal').send(event as object);
    const signatureIs = (valid: boolean) => jest.spyOn(PayPalClient, 'verifyWebhookSignature').mockResolvedValue(valid);

    /** Paiement déjà finalisé, et l'événement de capture que PayPal redélivre. */
    async function completedPaymentAndCaptureEvent() {
      const seller = await createTestUser();
      const buyer = await createTestUser();
      const product = await createTestProduct(seller._id, { isAvailable: false, isSold: true, soldTo: buyer._id });
      const payment = await Payment.create({
        product: product._id, buyer: buyer._id, seller: seller._id,
        amount: 20, currency: 'EUR', paymentIntentId: 'ORDER-1', captureId: 'CAPTURE-1',
        status: 'completed', completedAt: new Date(), paymentMethod: 'paypal', paymentType: 'direct'
      });
      const event = {
        id: 'WH-1',
        event_type: 'PAYMENT.CAPTURE.COMPLETED',
        resource: {
          id: 'CAPTURE-1',
          amount: { value: '20.00', currency_code: 'EUR' },
          supplementary_data: { related_ids: { order_id: 'ORDER-1' } }
        }
      };
      return { payment, event };
    }

    it('refuse un événement sans event_type (400)', async () => {
      const res = await postWebhook({ resource: {} });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_WEBHOOK');
    });

    it('rejette une signature invalide (401) sans traiter l\'événement', async () => {
      signatureIs(false);
      const handle = jest.spyOn(PayPalService, 'handleWebhook');

      const res = await postWebhook({ event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: {} });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('INVALID_WEBHOOK_SIGNATURE');
      expect(handle).not.toHaveBeenCalled();
    });

    it('accuse réception (200) d\'un type d\'événement non traité', async () => {
      signatureIs(true);

      const res = await postWebhook({ event_type: 'BILLING.PLAN.CREATED', resource: {} });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true, eventType: 'BILLING.PLAN.CREATED' });
    });

    it('accuse réception (200) d\'un événement déjà traité, sans rien rejouer', async () => {
      signatureIs(true);
      const { payment, event } = await completedPaymentAndCaptureEvent();
      const completedAt = payment.completedAt;

      const res = await postWebhook(event);

      expect(res.status).toBe(200);
      expect(await Payment.findById(payment._id)).toMatchObject({ status: 'completed', completedAt });
    });

    it('répond 5xx quand le traitement échoue, pour que PayPal redélivre l\'événement', async () => {
      signatureIs(true);
      const { event } = await completedPaymentAndCaptureEvent();
      jest.spyOn(Payment, 'findOne').mockRejectedValueOnce(new Error('Mongo indisponible'));

      const res = await postWebhook(event);

      expect(res.status).toBe(500);
      expect(res.body.received).toBeUndefined();
      expect(res.body.code).toBe('INTERNAL_SERVER_ERROR');
    });
  });

  describe('POST /api/payments/paypal/onboarding-link', () => {
    it('renvoie le lien d\'inscription PayPal et mémorise le tracking_id du vendeur', async () => {
      const seller = await createTestUser();
      const post = jest.spyOn(paypalHttp, 'post').mockResolvedValue({
        data: { links: [{ rel: 'action_url', href: 'https://paypal.test/onboard' }] }
      } as never);

      const res = await request(app).post('/api/payments/paypal/onboarding-link').set('Authorization', auth(seller));

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, actionUrl: 'https://paypal.test/onboard' });
      const sentBody = post.mock.calls[0][1] as { tracking_id: string };
      expect(sentBody.tracking_id.startsWith(`${seller._id}-`)).toBe(true);
      expect((await User.findById(seller._id))?.paypalTrackingId).toBe(sentBody.tracking_id);
    });

    it('répond 500 sans rien enregistrer quand PayPal ne renvoie pas d\'action_url', async () => {
      const seller = await createTestUser();
      jest.spyOn(paypalHttp, 'post').mockResolvedValue({ data: { links: [] } } as never);

      const res = await request(app).post('/api/payments/paypal/onboarding-link').set('Authorization', auth(seller));

      expect(res.status).toBe(500);
      expect((await User.findById(seller._id))?.paypalTrackingId).toBeFalsy();
    });
  });

  describe('GET /api/payments/paypal/account-status', () => {
    it('indique NOT_ONBOARDED à un vendeur sans compte PayPal relié', async () => {
      const seller = await createTestUser();

      const res = await request(app).get('/api/payments/paypal/account-status').set('Authorization', auth(seller));

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, connected: false, blockReason: 'NOT_ONBOARDED' });
    });

    it('rafraîchit le statut auprès de PayPal avec ?refresh=true', async () => {
      const seller = await createTestUser({ paypalMerchantId: 'MERCHANT-1' });
      jest.spyOn(paypalHttp, 'get').mockResolvedValue({
        data: {
          merchant_id: 'MERCHANT-1',
          payments_receivable: true,
          primary_email_confirmed: true,
          primary_email: 'vendeur@example.com',
          oauth_integrations: [{ oauth_third_party: [{ scopes: ['https://uri.paypal.com/services/payments/refund'] }] }]
        }
      } as never);

      const res = await request(app)
        .get('/api/payments/paypal/account-status?refresh=true')
        .set('Authorization', auth(seller));

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        connected: true,
        merchantId: 'MERCHANT-1',
        email: 'vendeur@example.com',
        blockReason: null
      });
    });
  });

  describe('POST /api/payments/paypal/capture', () => {
    it('refuse d\'encaisser un produit vendu entre-temps à un autre acheteur (409)', async () => {
      const seller = await createTestUser({ paypalMerchantId: 'MERCHANT-1' });
      const buyer = await createTestUser();
      const other = await createTestUser();
      const product = await createTestProduct(seller._id);
      await Payment.create({
        product: product._id, buyer: buyer._id, seller: seller._id,
        amount: 20, currency: 'EUR', paymentIntentId: 'ORDER-2',
        status: 'pending', paymentMethod: 'paypal', paymentType: 'direct'
      });
      await Product.updateOne({ _id: product._id }, { isSold: true, isAvailable: false, soldTo: other._id });
      const capture = jest.spyOn(PayPalService, 'captureConnectedPayment');

      const res = await request(app)
        .post('/api/payments/paypal/capture')
        .set('Authorization', auth(buyer))
        .send({ orderId: 'ORDER-2' });

      expect(res.status).toBe(409);
      expect(res.body.success).toBeUndefined();
      expect(capture).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/payments/my', () => {
    it('renvoie la pagination au format unifié', async () => {
      const buyer = await createTestUser();

      const res = await request(app).get('/api/payments/my?limit=5').set('Authorization', auth(buyer));

      expect(res.status).toBe(200);
      expect(res.body.pagination).toEqual({ page: 1, limit: 5, total: 0, pages: 0 });
    });
  });
});
