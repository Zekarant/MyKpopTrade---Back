import request from 'supertest';
import { createApp } from '../../app';
import { startInMemoryMongo, stopInMemoryMongo, clearAllCollections } from '../helpers/mongoMemory';
import { createTestUser, createTestProduct } from '../helpers/fixtures';
import KpopGroup from '../../models/kpopGroupModel';
import Album from '../../models/albumModel';
import Conversation from '../../models/conversationModel';
import Message from '../../models/messageModel';
import { listUserConversations } from '../../modules/messaging/services/conversationService';
import { generateAccessToken } from '../../commons/services/tokenService';

/** Lectures regroupées (anti N+1) : résultats inchangés, cas limites compris. */
const app = createApp();

describe('lectures regroupées (N+1)', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 60000);

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  beforeEach(async () => {
    await clearAllCollections();
  });

  describe('GET /api/groups/search — statistiques d\'albums par groupe', () => {
    it('rend les statistiques de chaque groupe, et des zéros sans album', async () => {
      const twice = await KpopGroup.create({ name: 'TWICE', isActive: true });
      await KpopGroup.create({ name: 'TWS', isActive: true });
      await Album.create({ name: 'A', artistId: twice._id, artistName: 'TWICE', totalTracks: 5, releaseDate: new Date('2020-01-01') });
      await Album.create({ name: 'B', artistId: twice._id, artistName: 'TWICE', totalTracks: 7, releaseDate: new Date('2023-06-01') });

      const res = await request(app).get('/api/groups/search?query=TW');

      const stats = Object.fromEntries(res.body.groups.map((g: any) => [g.name, g.stats]));
      expect(stats.TWICE).toEqual({ albumCount: 2, totalTracks: 12, latestRelease: '2023-06-01T00:00:00.000Z' });
      expect(stats.TWS).toEqual({ albumCount: 0, totalTracks: 0, latestRelease: null });
    });
  });

  describe('GET /api/albums/group/:groupId — annonces par album', () => {
    it('compte les annonces en ligne du même album OU du même groupe, chacune une fois', async () => {
      const group = await KpopGroup.create({ name: 'IVE', isActive: true });
      await Album.create({ name: 'Eleven', artistId: group._id, artistName: 'IVE', totalTracks: 2 });
      await Album.create({ name: 'Love Dive', artistId: group._id, artistName: 'IVE', totalTracks: 2 });
      const seller = await createTestUser();
      await createTestProduct(seller._id, { kpopGroup: 'IVE', albumName: 'Eleven' });
      await createTestProduct(seller._id, { kpopGroup: 'IVE' });
      await createTestProduct(seller._id, { kpopGroup: 'Autre', albumName: 'Eleven' });
      await createTestProduct(seller._id, { kpopGroup: 'IVE', isAvailable: false });
      await createTestProduct(seller._id, { kpopGroup: 'Autre' });

      const res = await request(app).get(`/api/albums/group/${group._id}`);

      const counts = Object.fromEntries(res.body.albums.map((a: any) => [a.name, a.availableProducts]));
      expect(counts).toEqual({ Eleven: 3, 'Love Dive': 2 });
    });
  });

  describe('GET /api/products — noms de groupe et d\'album', () => {
    it('résout groupe et album par identifiant ou par nom, et laisse l\'inconnu tel quel', async () => {
      const bts = await KpopGroup.create({ name: 'BTS', isActive: true });
      const first = await Album.create({ name: 'Proof', artistId: bts._id, artistName: 'BTS', totalTracks: 3 });
      await Album.create({ name: 'Proof', artistId: bts._id, artistName: 'Homonyme', totalTracks: 3 });
      const seller = await createTestUser();
      await createTestProduct(seller._id, { title: 'par nom', kpopGroup: 'BTS', albumName: 'Proof' });
      await createTestProduct(seller._id, { title: 'par id', kpopGroup: String(bts._id) });
      await createTestProduct(seller._id, { title: 'inconnu', kpopGroup: 'Groupe inconnu' });

      const res = await request(app).get('/api/products?limit=10');

      const byTitle = Object.fromEntries(res.body.products.map((p: any) => [p.title, p]));
      expect(byTitle['par nom']).toMatchObject({
        kpopGroupName: 'BTS',
        kpopGroupId: String(bts._id),
        albumNameStr: 'Proof',
        albumId: String(first._id)
      });
      expect(byTitle['par id']).toMatchObject({ kpopGroupName: 'BTS', kpopGroupId: String(bts._id) });
      expect(byTitle.inconnu.kpopGroupName).toBeUndefined();
    });

    it('enrichit aussi la fiche d\'une annonce', async () => {
      await KpopGroup.create({ name: 'BTS', isActive: true });
      const seller = await createTestUser();
      const product = await createTestProduct(seller._id);

      const res = await request(app)
        .get(`/api/products/${product._id}`)
        .set('Authorization', `Bearer ${generateAccessToken(seller)}`);

      expect(res.body.product.kpopGroupName).toBe('BTS');
    });
  });

  describe('listUserConversations — non lus et dernier message', () => {
    it('compte les messages non lus reçus et rend le dernier message non supprimé', async () => {
      const me = await createTestUser();
      const other = await createTestUser();
      const conversation = await Conversation.create({ participants: [me._id, other._id], createdBy: me._id });
      const quiet = await Conversation.create({ participants: [me._id, other._id], createdBy: other._id });
      const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 12, minutes));
      await Message.create([
        { conversation: conversation._id, sender: other._id, content: 'non lu 1', contentType: 'text', createdAt: at(1) },
        { conversation: conversation._id, sender: other._id, content: 'lu', contentType: 'text', readBy: [me._id], createdAt: at(2) },
        { conversation: conversation._id, sender: me._id, content: 'le mien', contentType: 'text', createdAt: at(3) },
        { conversation: conversation._id, sender: other._id, content: 'non lu 2', contentType: 'text', createdAt: at(4) },
        { conversation: conversation._id, sender: other._id, content: 'supprimé', contentType: 'text', isDeleted: true, createdAt: at(5) }
      ]);

      const { conversations } = (await listUserConversations(me._id.toString(), 1, 20, 'all')) as { conversations: any[] };

      const busy = conversations.find((c: any) => String(c._id) === String(conversation._id))!;
      expect(busy.unreadCount).toBe(2);
      expect(busy.lastMessage).toMatchObject({ content: 'non lu 2', preview: 'non lu 2' });
      expect(busy.lastMessage.sender.username).toBe(other.username);
      const empty = conversations.find((c: any) => String(c._id) === String(quiet._id))!;
      expect(empty.unreadCount).toBe(0);
      expect(empty.lastMessage).toBeNull();
    });
  });
});
