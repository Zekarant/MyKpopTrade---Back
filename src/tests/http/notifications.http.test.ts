import request from 'supertest';
import { Types } from 'mongoose';
import { createApp } from '../../app';
import { startInMemoryMongo, stopInMemoryMongo, clearAllCollections } from '../helpers/mongoMemory';
import { createTestUser } from '../helpers/fixtures';
import { generateAccessToken } from '../../commons/services/tokenService';
import Notification from '../../models/notificationModel';
import PushSubscription from '../../models/pushSubscriptionModel';

const app = createApp();

type TestUser = Awaited<ReturnType<typeof createTestUser>>;
const auth = (user: TestUser) => `Bearer ${generateAccessToken(user)}`;

function seedNotifications(recipient: TestUser, count: number, overrides: { isRead?: boolean } = {}) {
  const now = Date.now();
  return Notification.insertMany(Array.from({ length: count }, (_, index) => ({
    recipient: recipient._id,
    type: 'system',
    title: `Notification ${index}`,
    content: 'Contenu',
    isRead: overrides.isRead ?? false,
    createdAt: new Date(now - index * 1000)
  })));
}

const VALID_SUBSCRIPTION = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
  keys: { p256dh: 'cle-publique', auth: 'secret-auth' }
};

describe('HTTP — notifications', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 60000);

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  beforeEach(async () => {
    await clearAllCollections();
  });

  describe('GET /api/notifications', () => {
    it('pagine les notifications du membre, plus récentes d\'abord, avec le nombre de non lues', async () => {
      const member = await createTestUser();
      await seedNotifications(member, 3);
      await seedNotifications(member, 2, { isRead: true });
      await seedNotifications(await createTestUser(), 4);

      const res = await request(app).get('/api/notifications').query({ limit: 2 }).set('Authorization', auth(member));

      expect(res.status).toBe(200);
      expect(res.body.notifications).toHaveLength(2);
      expect(res.body.notifications[0].title).toBe('Notification 0');
      expect(res.body.unreadCount).toBe(3);
      expect(res.body.pagination).toEqual({ page: 1, limit: 2, total: 5, pages: 3 });
    });

    it('filtre les non lues avec unread=true et borne la limite à 50', async () => {
      const member = await createTestUser();
      await seedNotifications(member, 2);
      await seedNotifications(member, 3, { isRead: true });

      const res = await request(app)
        .get('/api/notifications')
        .query({ unread: 'true', limit: 500 })
        .set('Authorization', auth(member));

      expect(res.body.notifications).toHaveLength(2);
      expect(res.body.pagination).toEqual({ page: 1, limit: 50, total: 2, pages: 1 });
    });

    it('exige une authentification', async () => {
      const res = await request(app).get('/api/notifications');
      expect(res.status).toBe(401);
    });
  });

  describe('lecture', () => {
    it('marque une notification comme lue', async () => {
      const member = await createTestUser();
      const [notification] = await seedNotifications(member, 1);

      const res = await request(app)
        .put(`/api/notifications/${notification._id}/read`)
        .set('Authorization', auth(member));

      expect(res.status).toBe(200);
      expect(res.body.notification.isRead).toBe(true);
      expect((await Notification.findById(notification._id))?.isRead).toBe(true);
    });

    it('répond 404 pour la notification d\'un autre membre, sans la modifier', async () => {
      const owner = await createTestUser();
      const [notification] = await seedNotifications(owner, 1);

      const res = await request(app)
        .put(`/api/notifications/${notification._id}/read`)
        .set('Authorization', auth(await createTestUser()));

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ message: 'Notification non trouvée ou non autorisée', code: 'NOTIFICATION_NOT_FOUND' });
      expect((await Notification.findById(notification._id))?.isRead).toBe(false);
    });

    it('répond 404 (et non 500) à un identifiant mal formé', async () => {
      const res = await request(app)
        .put('/api/notifications/pas-un-id/read')
        .set('Authorization', auth(await createTestUser()));

      expect(res.status).toBe(404);
    });

    it('marque toutes les notifications du membre comme lues, et seulement les siennes', async () => {
      const member = await createTestUser();
      const other = await createTestUser();
      await seedNotifications(member, 3);
      await seedNotifications(other, 2);

      const res = await request(app).put('/api/notifications/read-all').set('Authorization', auth(member));

      expect(res.status).toBe(200);
      expect(res.body.count).toBe(3);
      expect(await Notification.countDocuments({ recipient: other._id, isRead: false })).toBe(2);
    });
  });

  describe('suppression', () => {
    it('supprime une notification du membre', async () => {
      const member = await createTestUser();
      const [notification] = await seedNotifications(member, 1);

      const res = await request(app).delete(`/api/notifications/${notification._id}`).set('Authorization', auth(member));

      expect(res.status).toBe(200);
      expect(await Notification.exists({ _id: notification._id })).toBeNull();
    });

    it('répond 404 pour une notification inexistante ou d\'un autre membre', async () => {
      const owner = await createTestUser();
      const [notification] = await seedNotifications(owner, 1);
      const intruder = await createTestUser();

      const foreign = await request(app).delete(`/api/notifications/${notification._id}`).set('Authorization', auth(intruder));
      const missing = await request(app)
        .delete(`/api/notifications/${new Types.ObjectId()}`)
        .set('Authorization', auth(intruder));

      expect(foreign.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(await Notification.exists({ _id: notification._id })).not.toBeNull();
    });
  });

  describe('web push', () => {
    it('enregistre un abonnement, de façon idempotente', async () => {
      const member = await createTestUser();

      const first = await request(app)
        .post('/api/notifications/push/subscribe')
        .set('Authorization', auth(member))
        .send({ subscription: VALID_SUBSCRIPTION });
      await request(app)
        .post('/api/notifications/push/subscribe')
        .set('Authorization', auth(member))
        .send({ subscription: VALID_SUBSCRIPTION });

      expect(first.status).toBe(201);
      expect(first.body).toEqual({ success: true });
      expect(await PushSubscription.countDocuments({ user: member._id })).toBe(1);
    });

    it('refuse (400) un corps sans abonnement', async () => {
      const res = await request(app)
        .post('/api/notifications/push/subscribe')
        .set('Authorization', auth(await createTestUser()))
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('SUBSCRIPTION_REQUIRED');
    });

    it('refuse (400) un endpoint qui n\'est pas un service de push connu', async () => {
      const res = await request(app)
        .post('/api/notifications/push/subscribe')
        .set('Authorization', auth(await createTestUser()))
        .send({ subscription: { ...VALID_SUBSCRIPTION, endpoint: 'https://10.0.0.5/push' } });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ message: 'Subscription invalide', code: 'INVALID_PUSH_SUBSCRIPTION' });
      expect(await PushSubscription.countDocuments()).toBe(0);
    });

    it('désinscrit un abonnement du membre', async () => {
      const member = await createTestUser();
      await PushSubscription.create({ user: member._id, ...VALID_SUBSCRIPTION });

      const res = await request(app)
        .post('/api/notifications/push/unsubscribe')
        .set('Authorization', auth(member))
        .send({ endpoint: VALID_SUBSCRIPTION.endpoint });

      expect(res.status).toBe(200);
      expect(await PushSubscription.countDocuments()).toBe(0);
    });

    it('refuse (400) une désinscription sans endpoint', async () => {
      const res = await request(app)
        .post('/api/notifications/push/unsubscribe')
        .set('Authorization', auth(await createTestUser()))
        .send({});

      expect(res.status).toBe(400);
    });
  });
});
