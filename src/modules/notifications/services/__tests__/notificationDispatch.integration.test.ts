jest.mock('../../../../commons/services/emailService', () => ({
  sendNotificationEmail: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('../pushService', () => ({
  sendToUser: jest.fn().mockResolvedValue(undefined)
}));

import { startInMemoryMongo, stopInMemoryMongo, clearAllCollections } from '../../../../tests/helpers/mongoMemory';
import { createTestUser } from '../../../../tests/helpers/fixtures';
import { NotificationService } from '../notificationService';
import { sendNotificationEmail } from '../../../../commons/services/emailService';
import { sendToUser } from '../pushService';
import Notification from '../../../../models/notificationModel';
import User from '../../../../models/userModel';

const notify = (recipientId: unknown, type: string, extra: Record<string, unknown> = {}) =>
  NotificationService.createNotification({
    recipientId: recipientId as string,
    type,
    title: 'Titre',
    content: 'Contenu',
    link: '/account/purchases/p1',
    ...extra
  });

describe('NotificationService — canaux selon les préférences', () => {
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

  it('envoie l\'email d\'une catégorie activée par défaut (commandes)', async () => {
    const buyer = await createTestUser({ username: 'acheteuse' });

    await notify(buyer._id, 'order_status');

    expect(sendNotificationEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: buyer.email,
      username: 'acheteuse',
      title: 'Titre',
      link: '/account/purchases/p1'
    }));
    expect(sendToUser).toHaveBeenCalledTimes(1);
  });

  it('n\'envoie pas d\'email pour un message privé par défaut, mais garde le push et l\'in-app', async () => {
    const member = await createTestUser();

    await notify(member._id, 'message');

    expect(sendNotificationEmail).not.toHaveBeenCalled();
    expect(sendToUser).toHaveBeenCalledTimes(1);
    expect(await Notification.countDocuments({ recipient: member._id })).toBe(1);
  });

  it('respecte le refus d\'email et de push enregistré par le membre', async () => {
    const seller = await createTestUser();
    await User.updateOne({ _id: seller._id }, { $set: { 'preferences.notifications.orders': { email: false, push: false } } });

    await notify(seller._id, 'product_sold');

    expect(sendNotificationEmail).not.toHaveBeenCalled();
    expect(sendToUser).not.toHaveBeenCalled();
    expect(await Notification.countDocuments({ recipient: seller._id })).toBe(1);
  });

  it('envoie toujours les notifications système, même si le membre a tout coupé', async () => {
    const member = await createTestUser();
    const allOff = { email: false, push: false };
    await User.updateOne({ _id: member._id }, {
      $set: {
        'preferences.notifications': {
          orders: allOff, offers: allOff, messages: allOff, disputes: allOff, reviews: allOff, social: allOff
        }
      }
    });

    await notify(member._id, 'system');

    expect(sendNotificationEmail).toHaveBeenCalledTimes(1);
    expect(sendToUser).toHaveBeenCalledTimes(1);
  });

  it('transmet le suivi du colis de la notification d\'expédition à l\'email', async () => {
    const buyer = await createTestUser();

    await notify(buyer._id, 'order_status', {
      data: { carrier: 'Colissimo', trackingNumber: '6Z123', trackingUrl: 'https://suivi.example/6Z123' }
    });

    expect(sendNotificationEmail).toHaveBeenCalledWith(expect.objectContaining({
      tracking: { carrier: 'Colissimo', number: '6Z123', url: 'https://suivi.example/6Z123' }
    }));
  });

  it('un échec d\'envoi d\'email ne fait pas échouer la notification', async () => {
    const buyer = await createTestUser();
    (sendNotificationEmail as jest.Mock).mockRejectedValueOnce(new Error('SMTP indisponible'));

    await expect(notify(buyer._id, 'order_status')).resolves.toBeDefined();
    expect(await Notification.countDocuments({ recipient: buyer._id })).toBe(1);
  });
});
