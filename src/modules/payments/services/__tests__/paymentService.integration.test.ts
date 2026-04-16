jest.mock('../paypalService', () => ({
  PayPalService: {
    refundConnectedPayment: jest.fn(),
    captureConnectedPayment: jest.fn(),
    createDirectPayment: jest.fn(),
    checkPaymentStatus: jest.fn(),
    generateConnectUrl: jest.fn().mockReturnValue('https://paypal.test/connect'),
    handleConnectCallback: jest.fn(),
    handleWebhook: jest.fn()
  }
}));

jest.mock('../../../../commons/utils/encryptionService', () => ({
  EncryptionService: {
    decrypt: jest.fn((v: string) => v)
  }
}));

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
  buildConnectUrl,
  getPayPalConnectionStatus,
  disconnectPayPalForUser,
  processRefund,
  fetchPaymentStatus,
  fetchPaymentDetails,
  listUserPayments,
  captureDirectPayment
} from '../paymentService';
import { PayPalService } from '../paypalService';
import Payment from '../../../../models/paymentModel';
import User from '../../../../models/userModel';

describe('paymentService (integration)', () => {
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
      paymentIntentId: `pi_${Date.now()}`,
      status: 'completed',
      paymentMethod: 'paypal',
      paymentType: 'direct',
      captureId: 'cap_test_123',
      ...overrides
    });

    return { seller, buyer, product, payment };
  }

  describe('buildConnectUrl', () => {
    it('retourne une URL pour un utilisateur existant', async () => {
      const user = await createTestUser();
      const url = await buildConnectUrl(user._id.toString());
      expect(url).toBe('https://paypal.test/connect');
      expect(PayPalService.generateConnectUrl).toHaveBeenCalledWith(user._id.toString());
    });

    it('404 si utilisateur inexistant', async () => {
      await expect(
        buildConnectUrl('507f1f77bcf86cd799439011')
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('getPayPalConnectionStatus', () => {
    // Note: paypalConnected/paypalTokens ne sont pas dans le schema User.
    // On contourne avec collection.updateOne pour écrire ces champs bruts.
    async function setPaypalFields(userId: any, fields: any) {
      await User.collection.updateOne({ _id: userId }, { $set: fields });
    }

    it('connected=true si paypalConnected et token non expiré', async () => {
      const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const user = await createTestUser();
      await setPaypalFields(user._id, {
        paypalConnected: true,
        paypalTokens: { expiresAt: futureDate }
      });

      const status = await getPayPalConnectionStatus(user._id.toString());
      expect(status.connected).toBe(true);
      expect(status.expiresAt).toBeDefined();
    });

    it('connected=false si token expiré', async () => {
      const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const user = await createTestUser();
      await setPaypalFields(user._id, {
        paypalConnected: true,
        paypalTokens: { expiresAt: pastDate }
      });

      const status = await getPayPalConnectionStatus(user._id.toString());
      expect(status.connected).toBe(false);
    });

    it('connected=false si paypalConnected absent', async () => {
      const user = await createTestUser();
      const status = await getPayPalConnectionStatus(user._id.toString());
      expect(status.connected).toBe(false);
    });
  });

  describe('disconnectPayPalForUser', () => {
    it('désactive paypalConnected et supprime les tokens', async () => {
      const user = await createTestUser();
      await User.collection.updateOne(
        { _id: user._id },
        { $set: { paypalConnected: true, paypalTokens: { accessToken: 'secret' } } }
      );

      await disconnectPayPalForUser(user._id.toString());

      const refreshed = await User.collection.findOne({ _id: user._id });
      expect(refreshed?.paypalConnected).toBe(false);
      expect(refreshed?.paypalTokens).toBeUndefined();
    });

    it('404 si utilisateur inexistant', async () => {
      await expect(
        disconnectPayPalForUser('507f1f77bcf86cd799439011')
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('processRefund', () => {
    it('vendeur initie un remboursement complet avec succès', async () => {
      (PayPalService.refundConnectedPayment as jest.Mock).mockResolvedValue({
        id: 'refund_123',
        status: 'COMPLETED',
        createdAt: new Date()
      });

      const { seller, payment } = await createTestPayment();

      const result = await processRefund({
        userId: seller._id.toString(),
        paymentId: payment._id.toString()
      });

      expect(result.refundId).toBe('refund_123');
      expect(result.amount).toBeNull();
      expect(PayPalService.refundConnectedPayment).toHaveBeenCalledWith(
        'cap_test_123',
        null,
        '',
        seller._id.toString()
      );
    });

    it('remboursement partiel avec montant et raison', async () => {
      (PayPalService.refundConnectedPayment as jest.Mock).mockResolvedValue({
        id: 'refund_456',
        status: 'COMPLETED',
        createdAt: new Date()
      });

      const { seller, payment } = await createTestPayment();

      const result = await processRefund({
        userId: seller._id.toString(),
        paymentId: payment._id.toString(),
        amount: 10,
        reason: 'Article endommagé'
      });

      expect(result.amount).toBe(10);
      expect(PayPalService.refundConnectedPayment).toHaveBeenCalledWith(
        'cap_test_123',
        10,
        'Article endommagé',
        seller._id.toString()
      );
    });

    it('admin peut aussi rembourser (pas seulement le vendeur)', async () => {
      (PayPalService.refundConnectedPayment as jest.Mock).mockResolvedValue({
        id: 'refund_admin',
        status: 'COMPLETED',
        createdAt: new Date()
      });

      const admin = await createTestUser({ role: 'admin' });
      const { payment } = await createTestPayment();

      const result = await processRefund({
        userId: admin._id.toString(),
        paymentId: payment._id.toString()
      });

      expect(result.refundId).toBe('refund_admin');
    });

    it('403 avec code REFUND_PERMISSION_DENIED pour un autre user', async () => {
      const attacker = await createTestUser();
      const { payment } = await createTestPayment();

      await expect(
        processRefund({
          userId: attacker._id.toString(),
          paymentId: payment._id.toString()
        })
      ).rejects.toMatchObject({
        statusCode: 403,
        code: 'REFUND_PERMISSION_DENIED'
      });
    });

    it('404 si paiement inexistant', async () => {
      const user = await createTestUser();
      await expect(
        processRefund({
          userId: user._id.toString(),
          paymentId: '507f1f77bcf86cd799439011'
        })
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it('400 si paiement non complété (ex: pending)', async () => {
      const { seller, payment } = await createTestPayment({ status: 'pending' });

      await expect(
        processRefund({
          userId: seller._id.toString(),
          paymentId: payment._id.toString()
        })
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('400 si captureId absent', async () => {
      const { seller, payment } = await createTestPayment({ captureId: undefined });

      await expect(
        processRefund({
          userId: seller._id.toString(),
          paymentId: payment._id.toString()
        })
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('400 si PayPal rejette le remboursement', async () => {
      (PayPalService.refundConnectedPayment as jest.Mock).mockRejectedValue(
        new Error('Cette transaction a déjà été entièrement remboursée')
      );

      const { seller, payment } = await createTestPayment();

      await expect(
        processRefund({
          userId: seller._id.toString(),
          paymentId: payment._id.toString()
        })
      ).rejects.toMatchObject({
        statusCode: 400,
        message: 'Cette transaction a déjà été entièrement remboursée'
      });
    });
  });

  describe('captureDirectPayment', () => {
    it('met à jour le paiement et le produit après capture réussie', async () => {
      (PayPalService.captureConnectedPayment as jest.Mock).mockResolvedValue({
        captureId: 'cap_new_123',
        amount: '20.00',
        currency: 'EUR'
      });

      const seller = await createTestUser();
      await User.collection.updateOne(
        { _id: seller._id },
        { $set: { paypalConnected: true } }
      );
      const buyer = await createTestUser();
      const product = await createTestProduct(seller._id);
      const payment = await Payment.create({
        product: product._id,
        buyer: buyer._id,
        seller: seller._id,
        amount: 20,
        platformFee: 0,
        currency: 'EUR',
        paymentIntentId: 'pi_test_capture',
        status: 'pending',
        paymentMethod: 'paypal',
        paymentType: 'direct'
      });

      const result = await captureDirectPayment(buyer._id.toString(), 'pi_test_capture');

      expect(result.status).toBe('completed');
      expect(result.captureId).toBe('cap_new_123');

      const refreshedPayment = await Payment.findById(payment._id);
      expect(refreshedPayment?.status).toBe('completed');
      expect(refreshedPayment?.captureId).toBe('cap_new_123');
    });

    it('400 avec code SELLER_UNAVAILABLE si vendeur pas connecté PayPal', async () => {
      const seller = await createTestUser();
      const buyer = await createTestUser();
      const product = await createTestProduct(seller._id);
      await Payment.create({
        product: product._id,
        buyer: buyer._id,
        seller: seller._id,
        amount: 20,
        platformFee: 0,
        currency: 'EUR',
        paymentIntentId: 'pi_no_seller',
        status: 'pending',
        paymentMethod: 'paypal',
        paymentType: 'direct'
      });

      await expect(
        captureDirectPayment(buyer._id.toString(), 'pi_no_seller')
      ).rejects.toMatchObject({
        statusCode: 400,
        code: 'SELLER_UNAVAILABLE'
      });
    });

    it('400 si orderId manquant', async () => {
      const buyer = await createTestUser();
      await expect(
        captureDirectPayment(buyer._id.toString(), '')
      ).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  describe('fetchPaymentStatus', () => {
    it('buyer peut consulter son paiement', async () => {
      const { buyer, payment } = await createTestPayment();
      const result = await fetchPaymentStatus(buyer._id.toString(), payment._id.toString());
      expect(result.status).toBe('completed');
    });

    it('seller peut consulter aussi', async () => {
      const { seller, payment } = await createTestPayment();
      const result = await fetchPaymentStatus(seller._id.toString(), payment._id.toString());
      expect(result.status).toBe('completed');
    });

    it('admin peut consulter tous les paiements', async () => {
      const admin = await createTestUser({ role: 'admin' });
      const { payment } = await createTestPayment();
      const result = await fetchPaymentStatus(admin._id.toString(), payment._id.toString());
      expect(result.status).toBe('completed');
    });

    it('403 avec code PAYMENT_ACCESS_DENIED pour un tiers', async () => {
      const attacker = await createTestUser();
      const { payment } = await createTestPayment();

      await expect(
        fetchPaymentStatus(attacker._id.toString(), payment._id.toString())
      ).rejects.toMatchObject({
        statusCode: 403,
        code: 'PAYMENT_ACCESS_DENIED'
      });
    });

    it('404 si paiement inexistant', async () => {
      const user = await createTestUser();
      await expect(
        fetchPaymentStatus(user._id.toString(), '507f1f77bcf86cd799439011')
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('listUserPayments', () => {
    it('filtre par rôle buyer', async () => {
      const { buyer } = await createTestPayment();

      const result = await listUserPayments(buyer._id.toString(), 'buyer', undefined, 1, 10);

      expect(result.data.length).toBe(1);
      expect(result.pagination.total).toBe(1);
    });

    it('filtre par rôle seller', async () => {
      const { seller } = await createTestPayment();

      const result = await listUserPayments(seller._id.toString(), 'seller', undefined, 1, 10);

      expect(result.data.length).toBe(1);
    });

    it('role=all retourne les paiements où l\'utilisateur est buyer OU seller', async () => {
      const { seller, buyer } = await createTestPayment();

      const asSellerResult = await listUserPayments(seller._id.toString(), 'all', undefined, 1, 10);
      const asBuyerResult = await listUserPayments(buyer._id.toString(), 'all', undefined, 1, 10);

      expect(asSellerResult.data.length).toBe(1);
      expect(asBuyerResult.data.length).toBe(1);
    });

    it('filtre additionnel par statut', async () => {
      const { seller } = await createTestPayment({ status: 'completed' });
      await createTestPayment({ status: 'pending' });

      const result = await listUserPayments(
        seller._id.toString(),
        'seller',
        'completed',
        1,
        10
      );

      expect(result.data.length).toBe(1);
      expect(result.data[0].status).toBe('completed');
    });

    it('supprime les champs sensibles ipAddress et userAgent de la réponse', async () => {
      const { buyer } = await createTestPayment({
        ipAddress: '1.2.3.4',
        userAgent: 'Test/1.0'
      });

      const result = await listUserPayments(buyer._id.toString(), 'buyer', undefined, 1, 10);

      expect((result.data[0] as any).ipAddress).toBeUndefined();
      expect((result.data[0] as any).userAgent).toBeUndefined();
    });
  });

  describe('fetchPaymentDetails', () => {
    it('404 si paiement inexistant', async () => {
      const user = await createTestUser();
      await expect(
        fetchPaymentDetails(user._id.toString(), '507f1f77bcf86cd799439011')
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });
});
