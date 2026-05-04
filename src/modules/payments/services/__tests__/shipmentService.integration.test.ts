jest.mock('../../../notifications/services/notificationService', () => ({
  NotificationService: {
    createNotification: jest.fn().mockResolvedValue(undefined)
  }
}));

import {
  startInMemoryMongo,
  stopInMemoryMongo,
  clearAllCollections
} from '../../../../tests/helpers/mongoMemory';
import { createTestUser, createTestProduct } from '../../../../tests/helpers/fixtures';
import {
  markShipped,
  confirmDelivery,
  getShipment,
  buildTrackingUrl
} from '../shipmentService';
import { NotificationService } from '../../../notifications/services/notificationService';
import Payment from '../../../../models/paymentModel';

describe('shipmentService (integration)', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 60000);

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  beforeEach(async () => {
    await clearAllCollections();
    jest.clearAllMocks();
  });

  async function createTestPayment(overrides: any = {}) {
    const seller = await createTestUser();
    const buyer = await createTestUser();
    const product = await createTestProduct(seller._id);

    const payment = await Payment.create({
      product: product._id,
      buyer: buyer._id,
      seller: seller._id,
      amount: 20,
      platformFee: 0,
      currency: 'EUR',
      paymentIntentId: `pi_${Date.now()}_${Math.random()}`,
      status: 'completed',
      paymentMethod: 'paypal',
      paymentType: 'direct',
      captureId: 'cap_test_123',
      ...overrides
    });

    return { seller, buyer, product, payment };
  }

  describe('buildTrackingUrl', () => {
    it('génère l\'URL La Poste pour "Colissimo" (insensible à la casse)', () => {
      expect(buildTrackingUrl('Colissimo', '6Z00000123FR'))
        .toBe('https://www.laposte.fr/outils/suivre-vos-envois?code=6Z00000123FR');
    });

    it('génère l\'URL Mondial Relay (avec espace)', () => {
      expect(buildTrackingUrl('Mondial Relay', 'CT12345'))
        .toBe('https://www.mondialrelay.com/suivi-de-colis/?numeroExpedition=CT12345');
    });

    it('encode les caractères spéciaux du numéro de suivi', () => {
      expect(buildTrackingUrl('UPS', '1Z 999 AA1 01 2345 6784'))
        .toContain('tracknum=1Z%20999%20AA1%2001%202345%206784');
    });

    it('renvoie null pour un transporteur inconnu', () => {
      expect(buildTrackingUrl('Transporteur Maison', 'XYZ')).toBeNull();
    });
  });

  describe('markShipped', () => {
    it('enregistre l\'expédition et notifie l\'acheteur', async () => {
      const { seller, buyer, payment } = await createTestPayment();

      const shipment = await markShipped({
        userId: seller._id.toString(),
        paymentId: payment._id.toString(),
        carrier: 'Colissimo',
        trackingNumber: '6Z00000123FR'
      });

      expect(shipment.status).toBe('shipped');
      expect(shipment.carrier).toBe('Colissimo');
      expect(shipment.trackingNumber).toBe('6Z00000123FR');
      expect(shipment.trackingUrl).toContain('laposte.fr');
      expect(shipment.shippedAt).toBeDefined();
      expect(shipment.deliveredAt).toBeUndefined();

      const reloaded = await Payment.findById(payment._id);
      expect(reloaded?.shipment?.status).toBe('shipped');

      expect(NotificationService.createNotification).toHaveBeenCalledTimes(1);
      const call = (NotificationService.createNotification as jest.Mock).mock.calls[0][0];
      expect(call.recipientId.toString()).toBe(buyer._id.toString());
      expect(call.type).toBe('order_status');
    });

    it('utilise une URL fournie manuellement plutôt que celle dérivée du transporteur', async () => {
      const { seller, payment } = await createTestPayment();

      const shipment = await markShipped({
        userId: seller._id.toString(),
        paymentId: payment._id.toString(),
        carrier: 'Colissimo',
        trackingNumber: '6Z00000123FR',
        trackingUrl: 'https://example.com/track/abc'
      });

      expect(shipment.trackingUrl).toBe('https://example.com/track/abc');
    });

    it('laisse trackingUrl indéfini si transporteur inconnu et pas d\'URL fournie', async () => {
      const { seller, payment } = await createTestPayment();

      const shipment = await markShipped({
        userId: seller._id.toString(),
        paymentId: payment._id.toString(),
        carrier: 'Pigeon voyageur',
        trackingNumber: 'PV-001'
      });

      expect(shipment.trackingUrl).toBeUndefined();
    });

    it('403 si l\'utilisateur n\'est pas le vendeur', async () => {
      const { buyer, payment } = await createTestPayment();

      await expect(markShipped({
        userId: buyer._id.toString(),
        paymentId: payment._id.toString(),
        carrier: 'Colissimo',
        trackingNumber: 'X'
      })).rejects.toMatchObject({ statusCode: 403, code: 'SHIPMENT_FORBIDDEN' });
    });

    it('400 si le paiement n\'est pas complété', async () => {
      const { seller, payment } = await createTestPayment({ status: 'pending' });

      await expect(markShipped({
        userId: seller._id.toString(),
        paymentId: payment._id.toString(),
        carrier: 'Colissimo',
        trackingNumber: 'X'
      })).rejects.toMatchObject({ statusCode: 400, code: 'SHIPMENT_INVALID_STATE' });
    });

    it('400 si une expédition est déjà enregistrée', async () => {
      const { seller, payment } = await createTestPayment();

      await markShipped({
        userId: seller._id.toString(),
        paymentId: payment._id.toString(),
        carrier: 'Colissimo',
        trackingNumber: 'A'
      });

      await expect(markShipped({
        userId: seller._id.toString(),
        paymentId: payment._id.toString(),
        carrier: 'Colissimo',
        trackingNumber: 'B'
      })).rejects.toMatchObject({ statusCode: 400, code: 'SHIPMENT_INVALID_STATE' });
    });

    it('400 si le transporteur est manquant', async () => {
      const { seller, payment } = await createTestPayment();

      await expect(markShipped({
        userId: seller._id.toString(),
        paymentId: payment._id.toString(),
        carrier: '   ',
        trackingNumber: 'X'
      })).rejects.toMatchObject({ statusCode: 400 });
    });

    it('400 si la trackingUrl ne commence pas par http(s)', async () => {
      const { seller, payment } = await createTestPayment();

      await expect(markShipped({
        userId: seller._id.toString(),
        paymentId: payment._id.toString(),
        carrier: 'Colissimo',
        trackingNumber: 'X',
        trackingUrl: 'javascript:alert(1)'
      })).rejects.toMatchObject({ statusCode: 400 });
    });

    it('404 si paiement inexistant', async () => {
      const seller = await createTestUser();

      await expect(markShipped({
        userId: seller._id.toString(),
        paymentId: '507f1f77bcf86cd799439011',
        carrier: 'Colissimo',
        trackingNumber: 'X'
      })).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('confirmDelivery', () => {
    it('passe le statut à delivered et notifie le vendeur', async () => {
      const { seller, buyer, payment } = await createTestPayment();

      await markShipped({
        userId: seller._id.toString(),
        paymentId: payment._id.toString(),
        carrier: 'Colissimo',
        trackingNumber: '6Z00000123FR'
      });
      (NotificationService.createNotification as jest.Mock).mockClear();

      const shipment = await confirmDelivery(
        buyer._id.toString(),
        payment._id.toString()
      );

      expect(shipment.status).toBe('delivered');
      expect(shipment.deliveredAt).toBeDefined();

      expect(NotificationService.createNotification).toHaveBeenCalledTimes(1);
      const call = (NotificationService.createNotification as jest.Mock).mock.calls[0][0];
      expect(call.recipientId.toString()).toBe(seller._id.toString());
    });

    it('403 si l\'utilisateur n\'est pas l\'acheteur', async () => {
      const { seller, payment } = await createTestPayment();
      await markShipped({
        userId: seller._id.toString(),
        paymentId: payment._id.toString(),
        carrier: 'Colissimo',
        trackingNumber: 'X'
      });

      await expect(confirmDelivery(
        seller._id.toString(),
        payment._id.toString()
      )).rejects.toMatchObject({ statusCode: 403 });
    });

    it('400 si pas d\'expédition enregistrée', async () => {
      const { buyer, payment } = await createTestPayment();

      await expect(confirmDelivery(
        buyer._id.toString(),
        payment._id.toString()
      )).rejects.toMatchObject({ statusCode: 400, code: 'SHIPMENT_INVALID_STATE' });
    });

    it('400 si la livraison est déjà confirmée', async () => {
      const { seller, buyer, payment } = await createTestPayment();
      await markShipped({
        userId: seller._id.toString(),
        paymentId: payment._id.toString(),
        carrier: 'Colissimo',
        trackingNumber: 'X'
      });
      await confirmDelivery(buyer._id.toString(), payment._id.toString());

      await expect(confirmDelivery(
        buyer._id.toString(),
        payment._id.toString()
      )).rejects.toMatchObject({ statusCode: 400, code: 'SHIPMENT_INVALID_STATE' });
    });
  });

  describe('getShipment', () => {
    it('renvoie l\'expédition pour le vendeur', async () => {
      const { seller, payment } = await createTestPayment();
      await markShipped({
        userId: seller._id.toString(),
        paymentId: payment._id.toString(),
        carrier: 'Colissimo',
        trackingNumber: 'X'
      });

      const shipment = await getShipment(seller._id.toString(), payment._id.toString());
      expect(shipment?.carrier).toBe('Colissimo');
    });

    it('renvoie l\'expédition pour l\'acheteur', async () => {
      const { seller, buyer, payment } = await createTestPayment();
      await markShipped({
        userId: seller._id.toString(),
        paymentId: payment._id.toString(),
        carrier: 'Colissimo',
        trackingNumber: 'X'
      });

      const shipment = await getShipment(buyer._id.toString(), payment._id.toString());
      expect(shipment?.carrier).toBe('Colissimo');
    });

    it('renvoie null si pas encore expédié', async () => {
      const { seller, payment } = await createTestPayment();
      const shipment = await getShipment(seller._id.toString(), payment._id.toString());
      expect(shipment).toBeNull();
    });

    it('403 pour un tiers', async () => {
      const stranger = await createTestUser();
      const { payment } = await createTestPayment();

      await expect(getShipment(
        stranger._id.toString(),
        payment._id.toString()
      )).rejects.toMatchObject({ statusCode: 403 });
    });
  });
});
