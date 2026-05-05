jest.mock('../../../notifications/services/notificationService', () => ({
  NotificationService: {
    createNotification: jest.fn().mockResolvedValue(undefined)
  }
}));

jest.mock('../../../../commons/services/emailService', () => ({
  sendShipmentShippedEmail: jest.fn().mockResolvedValue(undefined),
  sendShipmentDeliveredEmail: jest.fn().mockResolvedValue(undefined),
  sendShipmentReminderEmail: jest.fn().mockResolvedValue(undefined),
  sendShipmentAutoConfirmedEmail: jest.fn().mockResolvedValue(undefined)
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
  pollShipment,
  pollPendingShipments,
  autoConfirmStaleShipments,
  sendStuckShipmentReminders
} from '../shipmentService';
import { resetTrackingProviderCache } from '../tracking';
import { NotificationService } from '../../../notifications/services/notificationService';
import {
  sendShipmentReminderEmail,
  sendShipmentAutoConfirmedEmail
} from '../../../../commons/services/emailService';
import Payment from '../../../../models/paymentModel';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Stub de TrackingProvider configurable test par test : on remplace
 * `require('../tracking').getTrackingProvider` à la volée plutôt que de
 * brancher l'env, ce qui garde les tests lisibles et indépendants.
 */
const trackingModule = require('../tracking');
function setProvider(stub: { name?: string; track: jest.Mock }) {
  resetTrackingProviderCache();
  trackingModule.getTrackingProvider = jest.fn().mockReturnValue({
    name: stub.name ?? 'stub',
    track: stub.track
  });
}

describe('shipmentService — automatisation', () => {
  const originalGetProvider = trackingModule.getTrackingProvider;

  beforeAll(async () => {
    await startInMemoryMongo();
  }, 60000);

  afterAll(async () => {
    await stopInMemoryMongo();
    trackingModule.getTrackingProvider = originalGetProvider;
  });

  beforeEach(async () => {
    await clearAllCollections();
    jest.clearAllMocks();
    resetTrackingProviderCache();
    trackingModule.getTrackingProvider = originalGetProvider;
  });

  async function createPaymentWithShipment(overrides: any = {}) {
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

    await markShipped({
      userId: seller._id.toString(),
      paymentId: payment._id.toString(),
      carrier: 'Colissimo',
      trackingNumber: '6Z00000123FR'
    });

    return { seller, buyer, payment: await Payment.findById(payment._id) };
  }

  describe('events timeline', () => {
    it('ajoute un event "shipped" lors de markShipped', async () => {
      const { payment } = await createPaymentWithShipment();
      expect(payment?.shipment?.events).toHaveLength(1);
      expect(payment?.shipment?.events?.[0]).toMatchObject({
        status: 'shipped',
        source: 'seller'
      });
    });

    it('ajoute un event "delivered" avec source buyer lors de confirmDelivery', async () => {
      const { buyer, payment } = await createPaymentWithShipment();
      await confirmDelivery(buyer!._id.toString(), payment!._id.toString());

      const reloaded = await Payment.findById(payment!._id);
      expect(reloaded?.shipment?.events).toHaveLength(2);
      expect(reloaded?.shipment?.events?.[1]).toMatchObject({
        status: 'delivered',
        source: 'buyer'
      });
      expect(reloaded?.shipment?.autoConfirmedAt).toBeUndefined();
    });
  });

  describe('pollShipment', () => {
    it('ajoute les nouveaux events du carrier à la timeline', async () => {
      const { payment } = await createPaymentWithShipment();

      const futureDate = new Date(Date.now() + 60_000);
      setProvider({
        track: jest.fn().mockResolvedValue({
          status: 'in_transit',
          events: [
            { status: 'in_transit', occurredAt: futureDate, location: 'Lyon', description: 'En cours de transit' }
          ]
        })
      });

      await pollShipment(payment);

      const reloaded = await Payment.findById(payment!._id);
      expect(reloaded?.shipment?.events).toHaveLength(2);
      const last = reloaded!.shipment!.events![1];
      expect(last.status).toBe('in_transit');
      expect(last.source).toBe('carrier');
      expect(last.location).toBe('Lyon');
      expect(reloaded?.shipment?.lastTrackedAt).toBeDefined();
    });

    it('est idempotent : un événement déjà connu n\'est pas dupliqué', async () => {
      const { payment } = await createPaymentWithShipment();
      const occurredAt = new Date(Date.now() + 60_000);

      const provider = {
        track: jest.fn().mockResolvedValue({
          status: 'in_transit',
          events: [{ status: 'in_transit', occurredAt }]
        })
      };
      setProvider(provider);

      await pollShipment(payment);
      const reloaded1 = await Payment.findById(payment!._id);
      const countAfterFirst = reloaded1!.shipment!.events!.length;

      await pollShipment(reloaded1);
      const reloaded2 = await Payment.findById(payment!._id);
      expect(reloaded2!.shipment!.events!.length).toBe(countAfterFirst);
    });

    it('passe le shipment à delivered si le carrier signale delivered', async () => {
      const { payment } = await createPaymentWithShipment();
      const deliveredAt = new Date(Date.now() + 60_000);

      setProvider({
        track: jest.fn().mockResolvedValue({
          status: 'delivered',
          events: [{ status: 'delivered', occurredAt: deliveredAt, description: 'Remis au destinataire' }]
        })
      });

      const wasDelivered = await pollShipment(payment);

      const reloaded = await Payment.findById(payment!._id);
      expect(wasDelivered).toBe(true);
      expect(reloaded?.shipment?.status).toBe('delivered');
      expect(reloaded?.shipment?.deliveredAt).toBeDefined();
      // applyDelivery ajoute son propre event "delivered" en plus de celui du carrier
      const deliveredEvents = reloaded!.shipment!.events!.filter((e: any) => e.status === 'delivered');
      expect(deliveredEvents.length).toBeGreaterThanOrEqual(1);
    });

    it('ignore les shipments déjà delivered', async () => {
      const { buyer, payment } = await createPaymentWithShipment();
      await confirmDelivery(buyer!._id.toString(), payment!._id.toString());

      const provider = { track: jest.fn() };
      setProvider(provider);

      const reloaded = await Payment.findById(payment!._id);
      const result = await pollShipment(reloaded);
      expect(result).toBe(false);
      expect(provider.track).not.toHaveBeenCalled();
    });
  });

  describe('pollPendingShipments', () => {
    it('itère uniquement sur les shipments non délivrés et tolère une erreur isolée', async () => {
      await createPaymentWithShipment();
      await createPaymentWithShipment();
      const delivered = await createPaymentWithShipment();
      // delivered est déjà confirmé → ne doit pas être pollé
      await confirmDelivery(delivered.buyer._id.toString(), delivered.payment!._id.toString());

      const futureDate = new Date(Date.now() + 60_000);
      const track = jest.fn()
        .mockResolvedValueOnce({ status: 'in_transit', events: [{ status: 'in_transit', occurredAt: futureDate }] })
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce({ status: 'in_transit', events: [] });

      setProvider({ track });

      const result = await pollPendingShipments();
      expect(result.checked).toBe(2);
      expect(track).toHaveBeenCalledTimes(2);
    });
  });

  describe('autoConfirmStaleShipments', () => {
    it('auto-confirme les shipments shipped depuis plus de 14 jours', async () => {
      const { payment } = await createPaymentWithShipment();
      // recule artificiellement la date d'expédition
      await Payment.updateOne(
        { _id: payment!._id },
        { $set: { 'shipment.shippedAt': new Date(Date.now() - 15 * MS_PER_DAY) } }
      );
      // Le markShipped initial a déjà notifié l'acheteur — on remet à zéro
      // pour ne mesurer que l'effet d'autoConfirmStaleShipments.
      (NotificationService.createNotification as jest.Mock).mockClear();

      const result = await autoConfirmStaleShipments();
      expect(result.confirmed).toBe(1);

      const reloaded = await Payment.findById(payment!._id);
      expect(reloaded?.shipment?.status).toBe('delivered');
      expect(reloaded?.shipment?.autoConfirmedAt).toBeDefined();
      expect(NotificationService.createNotification).toHaveBeenCalledTimes(2); // buyer + seller
      expect(sendShipmentAutoConfirmedEmail).toHaveBeenCalledTimes(2);
    });

    it('laisse intacts les shipments expédiés récemment', async () => {
      const { payment } = await createPaymentWithShipment();
      await Payment.updateOne(
        { _id: payment!._id },
        { $set: { 'shipment.shippedAt': new Date(Date.now() - 5 * MS_PER_DAY) } }
      );

      const result = await autoConfirmStaleShipments();
      expect(result.confirmed).toBe(0);

      const reloaded = await Payment.findById(payment!._id);
      expect(reloaded?.shipment?.status).toBe('shipped');
    });
  });

  describe('sendStuckShipmentReminders', () => {
    it('envoie une relance après 7 jours et marque lastReminderAt', async () => {
      const { payment } = await createPaymentWithShipment();
      await Payment.updateOne(
        { _id: payment!._id },
        { $set: { 'shipment.shippedAt': new Date(Date.now() - 8 * MS_PER_DAY) } }
      );

      const result = await sendStuckShipmentReminders();
      expect(result.sent).toBe(1);
      expect(sendShipmentReminderEmail).toHaveBeenCalledTimes(1);

      const reloaded = await Payment.findById(payment!._id);
      expect(reloaded?.shipment?.lastReminderAt).toBeDefined();
    });

    it('respecte le cooldown entre deux relances', async () => {
      const { payment } = await createPaymentWithShipment();
      await Payment.updateOne(
        { _id: payment!._id },
        {
          $set: {
            'shipment.shippedAt': new Date(Date.now() - 8 * MS_PER_DAY),
            'shipment.lastReminderAt': new Date(Date.now() - 1 * MS_PER_DAY)
          }
        }
      );

      const result = await sendStuckShipmentReminders();
      expect(result.sent).toBe(0);
      expect(sendShipmentReminderEmail).not.toHaveBeenCalled();
    });

    it('ne relance pas un shipment expédié il y a moins de 7 jours', async () => {
      const { payment } = await createPaymentWithShipment();
      await Payment.updateOne(
        { _id: payment!._id },
        { $set: { 'shipment.shippedAt': new Date(Date.now() - 3 * MS_PER_DAY) } }
      );

      const result = await sendStuckShipmentReminders();
      expect(result.sent).toBe(0);
    });
  });
});
