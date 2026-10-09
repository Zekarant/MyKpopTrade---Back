import request from 'supertest';
import mongoose from 'mongoose';
import { createApp } from '../../app';
import { startInMemoryMongo, stopInMemoryMongo, clearAllCollections } from '../helpers/mongoMemory';
import { createTestUser } from '../helpers/fixtures';
import { generateAccessToken } from '../../commons/services/tokenService';
import SavedSearch from '../../modules/savedSearches/model';
import { MAX_SAVED_SEARCHES_PER_USER } from '../../modules/savedSearches/service';

/** Recherches sauvegardées : CRUD réservé à leur propriétaire, critères en liste blanche. */
const app = createApp();

describe('HTTP — recherches sauvegardées', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 60000);

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  beforeEach(async () => {
    await clearAllCollections();
  });

  const auth = (user: Awaited<ReturnType<typeof createTestUser>>) => `Bearer ${generateAccessToken(user)}`;
  const aSearch = { name: 'Photocards BTS', criteria: { groups: ['BTS'], type: 'photocard', priceRange: { max: 30 } } };

  it('crée, liste, modifie puis supprime une recherche', async () => {
    const me = await createTestUser();

    const created = await request(app).post('/api/saved-searches').set('Authorization', auth(me)).send(aSearch);
    const id = created.body.savedSearch._id;
    const renamed = await request(app)
      .patch(`/api/saved-searches/${id}`)
      .set('Authorization', auth(me))
      .send({ name: 'BTS pas chères', alertsEnabled: false });
    const listed = await request(app).get('/api/saved-searches').set('Authorization', auth(me));
    const deleted = await request(app).delete(`/api/saved-searches/${id}`).set('Authorization', auth(me));

    expect(created.status).toBe(201);
    expect(created.headers.location).toBe(`/api/saved-searches/${id}`);
    expect(created.body.savedSearch).toMatchObject({ ...aSearch, alertsEnabled: true });
    expect(renamed.body.savedSearch).toMatchObject({ name: 'BTS pas chères', alertsEnabled: false });
    expect(listed.body.savedSearches).toHaveLength(1);
    expect(deleted.status).toBe(204);
    expect(await SavedSearch.countDocuments()).toBe(0);
  });

  it('n\'expose pas les champs internes d\'alerte', async () => {
    const me = await createTestUser();
    await request(app).post('/api/saved-searches').set('Authorization', auth(me)).send(aSearch);

    const res = await request(app).get('/api/saved-searches').set('Authorization', auth(me));

    expect(Object.keys(res.body.savedSearches[0]).sort()).toEqual(
      ['_id', 'alertsEnabled', 'createdAt', 'criteria', 'lastNotifiedAt', 'name']
    );
  });

  it('exige une authentification', async () => {
    const res = await request(app).get('/api/saved-searches');

    expect(res.status).toBe(401);
  });

  it('répond 404 à un autre membre, sans rien modifier ni supprimer', async () => {
    const owner = await createTestUser();
    const intruder = await createTestUser();
    const created = await request(app).post('/api/saved-searches').set('Authorization', auth(owner)).send(aSearch);
    const id = created.body.savedSearch._id;

    const patched = await request(app)
      .patch(`/api/saved-searches/${id}`)
      .set('Authorization', auth(intruder))
      .send({ name: 'Piratée' });
    const deleted = await request(app).delete(`/api/saved-searches/${id}`).set('Authorization', auth(intruder));
    const listed = await request(app).get('/api/saved-searches').set('Authorization', auth(intruder));

    expect(patched.status).toBe(404);
    expect(deleted.status).toBe(404);
    expect(listed.body.savedSearches).toHaveLength(0);
    expect(await SavedSearch.findById(id)).toMatchObject({ name: aSearch.name });
  });

  it('répond 404 sans détail interne pour un identifiant invalide', async () => {
    const me = await createTestUser();

    const res = await request(app).delete('/api/saved-searches/pas-un-id').set('Authorization', auth(me));

    expect(res.status).toBe(404);
    expect(res.body.message).not.toMatch(/Cast/);
  });

  it('refuse un critère hors liste blanche ou une modification des critères', async () => {
    const me = await createTestUser();

    const created = await request(app)
      .post('/api/saved-searches')
      .set('Authorization', auth(me))
      .send({ name: 'X', criteria: { query: 'bts', isAvailable: false } });
    const ok = await request(app).post('/api/saved-searches').set('Authorization', auth(me)).send(aSearch);
    const patched = await request(app)
      .patch(`/api/saved-searches/${ok.body.savedSearch._id}`)
      .set('Authorization', auth(me))
      .send({ criteria: { query: 'twice' } });

    expect(created.status).toBe(400);
    expect(created.body.message).toMatch(/isAvailable/);
    expect(patched.status).toBe(400);
  });

  it(`plafonne à ${MAX_SAVED_SEARCHES_PER_USER} recherches par membre`, async () => {
    const me = await createTestUser();
    await SavedSearch.insertMany(
      Array.from({ length: MAX_SAVED_SEARCHES_PER_USER }, (_, i) => ({
        user: me._id,
        name: `Recherche ${i}`,
        criteria: { query: `q${i}` }
      }))
    );

    const res = await request(app).post('/api/saved-searches').set('Authorization', auth(me)).send(aSearch);

    expect(res.status).toBe(409);
    expect(await SavedSearch.countDocuments({ user: me._id })).toBe(MAX_SAVED_SEARCHES_PER_USER);
  });

  it('abandonne les annonces en attente quand les alertes sont coupées', async () => {
    const me = await createTestUser();
    const created = await request(app).post('/api/saved-searches').set('Authorization', auth(me)).send(aSearch);
    const id = created.body.savedSearch._id;
    await SavedSearch.updateOne(
      { _id: id },
      { pendingProductIds: [new mongoose.Types.ObjectId()], pendingSince: new Date() }
    );

    await request(app).patch(`/api/saved-searches/${id}`).set('Authorization', auth(me)).send({ alertsEnabled: false });

    const stored = await SavedSearch.findById(id).select('+pendingProductIds +pendingSince');
    expect(stored?.pendingProductIds).toHaveLength(0);
    expect(stored?.pendingSince).toBeUndefined();
  });
});
