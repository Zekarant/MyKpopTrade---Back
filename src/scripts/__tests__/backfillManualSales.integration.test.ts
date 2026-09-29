import {
  startInMemoryMongo,
  stopInMemoryMongo,
  clearAllCollections
} from '../../tests/helpers/mongoMemory';
import { createTestProduct, createTestUser } from '../../tests/helpers/fixtures';
import Product from '../../models/productModel';
import Payment from '../../models/paymentModel';
import Notification from '../../models/notificationModel';
import { backfillManualSales } from '../backfillManualSales';

describe('backfillManualSales (integration)', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 60000);

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  beforeEach(async () => {
    await clearAllCollections();
  });

  async function legacyListings() {
    const seller = await createTestUser();
    const buyer = await createTestUser();
    const withdrawn = { isAvailable: false };
    const paid = await createTestProduct(seller._id, { ...withdrawn, title: 'Payé' });
    const notified = await createTestProduct(seller._id, { ...withdrawn, title: 'Notifié' });
    const unknown = await createTestProduct(seller._id, { ...withdrawn, title: 'Sans indice' });
    const suspended = await createTestProduct(seller._id, {
      ...withdrawn,
      title: 'Suspendu',
      moderationFlag: {
        suspect: true, confidence: 'high', reasoning: 'test', categories: [], matchedKeywords: [],
        keywordsVersion: '1', policyVersion: '1', model: 'test', provider: 'mistral', analyzedAt: new Date()
      }
    });
    const completedAt = new Date('2026-05-01T10:00:00Z');
    await Payment.create({
      product: paid._id, buyer: buyer._id, seller: seller._id,
      amount: 20, currency: 'EUR', paymentIntentId: 'ORDER-1', status: 'completed', completedAt
    });
    const notifiedAt = new Date('2026-06-01T10:00:00Z');
    await Notification.create({
      recipient: buyer._id,
      type: 'wishlist_unavailable',
      title: 'Un favori n\'est plus disponible',
      content: 'Notifié a été vendu.',
      data: { productId: notified._id, reason: 'sold' },
      createdAt: notifiedAt
    });
    return { buyer, paid, notified, unknown, suspended, completedAt, notifiedAt };
  }

  it('n\'écrit rien en simulation', async () => {
    const { paid, notified } = await legacyListings();

    const report = await backfillManualSales({ apply: false });

    expect(report).toMatchObject({ fromPayments: 1, fromNotifications: 1 });
    expect(await Product.countDocuments({ _id: { $in: [paid._id, notified._id] }, isSold: true })).toBe(0);
  });

  it('marque vendus les articles payés ou notifiés « vendu », et laisse les autres au vendeur', async () => {
    const { buyer, paid, notified, unknown, suspended, completedAt, notifiedAt } = await legacyListings();

    const report = await backfillManualSales({ apply: true });

    expect(await Product.findById(paid._id)).toMatchObject({ isSold: true, soldAt: completedAt, soldTo: buyer._id });
    expect(await Product.findById(notified._id)).toMatchObject({ isSold: true, soldAt: notifiedAt });
    expect((await Product.findById(unknown._id))?.isSold).toBe(false);
    expect((await Product.findById(suspended._id))?.isSold).toBe(false);
    expect(report.undecided.map((product) => product.title)).toEqual(['Sans indice']);
  });

  it('peut être relancé sans effet', async () => {
    await legacyListings();
    await backfillManualSales({ apply: true });

    expect(await backfillManualSales({ apply: true })).toMatchObject({ fromPayments: 0, fromNotifications: 0 });
  });
});
