import { Types } from 'mongoose';
import {
  startInMemoryMongo,
  stopInMemoryMongo,
  clearAllCollections
} from '../../../tests/helpers/mongoMemory';
import { createTestUser, createTestProduct } from '../../../tests/helpers/fixtures';
import Notification from '../../../models/notificationModel';
import Block from '../../../models/blockModel';
import KpopGroup from '../../../models/kpopGroupModel';
import SavedSearch from '../model';
import { createSavedSearch } from '../service';
import {
  notifyMatchingSavedSearches,
  flushDueSavedSearchAlerts,
  SAVED_SEARCH_ALERT_COOLDOWN_MS
} from '../alertService';
import type { SavedSearchCriteria } from '../validation';

const T0 = new Date('2026-10-09T10:00:00Z');
const minutesAfter = (minutes: number) => new Date(T0.getTime() + minutes * 60 * 1000);

describe('alertService (integration)', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 60000);

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  beforeEach(async () => {
    await clearAllCollections();
  });

  async function aWatcher(criteria: SavedSearchCriteria = { groups: ['bts'] }) {
    const user = await createTestUser();
    const search = await createSavedSearch(String(user._id), { name: 'Mes BTS', criteria });
    return { user, search };
  }

  const alertsFor = (userId: Types.ObjectId) => Notification.find({ recipient: userId, type: 'saved_search_match' });

  it('notifie une recherche correspondante avec un lien vers l\'annonce', async () => {
    const { user } = await aWatcher();
    const seller = await createTestUser();
    const product = await createTestProduct(seller._id, { kpopGroup: 'BTS' });

    const matched = await notifyMatchingSavedSearches(String(product._id), T0);

    const [alert] = await alertsFor(user._id);
    expect(matched).toBe(1);
    expect(alert.link).toBe(`/products/${product._id}`);
    expect(alert.title).toBe('Nouvelle annonce pour « Mes BTS »');
  });

  it('trouve aussi les recherches sans groupe, filtrées en mémoire sur le reste', async () => {
    const { user: cheap } = await aWatcher({ priceRange: { max: 30 } });
    const { user: expensive } = await aWatcher({ priceRange: { min: 100 } });
    const seller = await createTestUser();
    const product = await createTestProduct(seller._id, { price: 20 });

    await notifyMatchingSavedSearches(String(product._id), T0);

    expect(await alertsFor(cheap._id)).toHaveLength(1);
    expect(await alertsFor(expensive._id)).toHaveLength(0);
  });

  it('suit les critères du catalogue, y compris pour une ancienne annonce qui n\'a que le nom du groupe', async () => {
    const bts = await KpopGroup.create({ name: 'BTS', profileImage: '/uploads/groups/bts.jpg' });
    const { user } = await aWatcher({ group: String(bts._id), member: 'Jungkook' });
    const seller = await createTestUser();
    const structured = await createTestProduct(seller._id, { kpopGroup: 'Bangtan', group: bts._id, member: 'Jungkook' });
    const legacy = await createTestProduct(seller._id, { kpopGroup: 'BTS', kpopMember: 'Jungkook' });
    const otherMember = await createTestProduct(seller._id, { group: bts._id, member: 'Jimin' });

    expect(await notifyMatchingSavedSearches(String(structured._id), T0)).toBe(1);
    expect(await notifyMatchingSavedSearches(String(legacy._id), minutesAfter(1))).toBe(1);
    expect(await notifyMatchingSavedSearches(String(otherMember._id), minutesAfter(2))).toBe(0);
    expect(await alertsFor(user._id)).toHaveLength(1);
  });

  it('n\'alerte ni le vendeur sur sa propre annonce, ni un membre bloqué', async () => {
    const { user: seller } = await aWatcher();
    const { user: blocked } = await aWatcher();
    await Block.create({ blocker: seller._id, blocked: blocked._id });
    const product = await createTestProduct(seller._id);

    const matched = await notifyMatchingSavedSearches(String(product._id), T0);

    expect(matched).toBe(0);
    expect(await Notification.countDocuments()).toBe(0);
  });

  it('n\'alerte pas pour une annonce en pause ou des recherches aux alertes coupées', async () => {
    const { user } = await aWatcher();
    await SavedSearch.updateMany({}, { alertsEnabled: false });
    const { user: other } = await aWatcher();
    const seller = await createTestUser();
    const paused = await createTestProduct(seller._id, { isAvailable: false });
    const visible = await createTestProduct(seller._id);

    await notifyMatchingSavedSearches(String(paused._id), T0);
    await notifyMatchingSavedSearches(String(visible._id), T0);

    expect(await alertsFor(user._id)).toHaveLength(0);
    expect(await alertsFor(other._id)).toHaveLength(1);
  });

  it('regroupe les annonces publiées dans l\'heure en une seule alerte suivante', async () => {
    const { user } = await aWatcher();
    const seller = await createTestUser();
    const first = await createTestProduct(seller._id, { title: 'Premier' });
    const second = await createTestProduct(seller._id, { title: 'Deuxième' });
    const third = await createTestProduct(seller._id, { title: 'Troisième' });

    await notifyMatchingSavedSearches(String(first._id), T0);
    await notifyMatchingSavedSearches(String(second._id), minutesAfter(10));
    await notifyMatchingSavedSearches(String(third._id), minutesAfter(20));
    expect(await alertsFor(user._id)).toHaveLength(1);

    const sentTooEarly = await flushDueSavedSearchAlerts(minutesAfter(30));
    const sent = await flushDueSavedSearchAlerts(new Date(T0.getTime() + SAVED_SEARCH_ALERT_COOLDOWN_MS));

    const alerts = await alertsFor(user._id);
    const grouped = alerts.find((alert) => alert.title === '2 nouvelles annonces pour « Mes BTS »');
    expect(sentTooEarly).toBe(0);
    expect(sent).toBe(1);
    expect(alerts).toHaveLength(2);
    expect((grouped?.data as { productIds: unknown[] }).productIds).toHaveLength(2);
  });

  it('n\'annonce pas dans l\'alerte groupée une annonce retirée entre-temps', async () => {
    const { user } = await aWatcher();
    const seller = await createTestUser();
    const first = await createTestProduct(seller._id);
    const withdrawn = await createTestProduct(seller._id);
    await notifyMatchingSavedSearches(String(first._id), T0);
    await notifyMatchingSavedSearches(String(withdrawn._id), minutesAfter(5));
    withdrawn.isAvailable = false;
    await withdrawn.save();

    const sent = await flushDueSavedSearchAlerts(minutesAfter(61));

    expect(sent).toBe(0);
    expect(await alertsFor(user._id)).toHaveLength(1);
  });
});
