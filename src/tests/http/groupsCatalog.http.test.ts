import request from 'supertest';
import { Types } from 'mongoose';
import { createApp } from '../../app';
import { startInMemoryMongo, stopInMemoryMongo, clearAllCollections } from '../helpers/mongoMemory';
import { createTestUser } from '../helpers/fixtures';
import { generateAccessToken } from '../../commons/services/tokenService';
import KpopGroup from '../../models/kpopGroupModel';
import Album from '../../models/albumModel';
import User from '../../models/userModel';

const app = createApp();

type TestUser = Awaited<ReturnType<typeof createTestUser>>;
const auth = (user: TestUser) => `Bearer ${generateAccessToken(user)}`;
const adminAuth = async () => auth(await createTestUser({ role: 'admin' }));

describe('HTTP — groupes et albums du catalogue', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 60000);

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  beforeEach(async () => {
    await clearAllCollections();
  });

  describe('groupes — administration', () => {
    it('réserve la création aux administrateurs', async () => {
      const res = await request(app)
        .post('/api/groups')
        .set('Authorization', auth(await createTestUser()))
        .send({ name: 'ATEEZ' });

      expect(res.status).toBe(403);
      expect(await KpopGroup.countDocuments()).toBe(0);
    });

    it('refuse un doublon de nom, sans tenir compte de la casse', async () => {
      await KpopGroup.create({ name: 'SEVENTEEN' });

      const res = await request(app)
        .post('/api/groups')
        .set('Authorization', await adminAuth())
        .send({ name: 'seventeen' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('GROUP_ALREADY_EXISTS');
    });

    it('renomme un groupe et répercute le nom sur ses albums', async () => {
      const group = await KpopGroup.create({ name: 'Ancien nom' });
      await Album.create({ name: 'Debut', artistId: group._id, artistName: group.name });

      const res = await request(app)
        .put(`/api/groups/${group._id}`)
        .set('Authorization', await adminAuth())
        .send({ name: 'Nouveau nom' });

      expect(res.status).toBe(200);
      expect(res.body.group.name).toBe('Nouveau nom');
      expect((await Album.findOne({ artistId: group._id }).lean())?.artistName).toBe('Nouveau nom');
    });

    it('supprime un groupe avec ses albums', async () => {
      const group = await KpopGroup.create({ name: 'MAMAMOO' });
      await Album.create([
        { name: 'Reality in Black', artistId: group._id, artistName: group.name },
        { name: 'Travel', artistId: group._id, artistName: group.name }
      ]);

      const res = await request(app).delete(`/api/groups/${group._id}`).set('Authorization', await adminAuth());

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ message: 'Groupe supprimé avec succès', albumsDeleted: 2 });
      expect(await KpopGroup.exists({ _id: group._id })).toBeNull();
      expect(await Album.countDocuments()).toBe(0);
    });

    it('répond 404 à la mise à jour ou la suppression d\'un groupe inexistant, 400 à un identifiant invalide', async () => {
      const authorization = await adminAuth();

      const missingUpdate = await request(app)
        .put(`/api/groups/${new Types.ObjectId()}`)
        .set('Authorization', authorization)
        .send({ tags: ['x'] });
      const missingDelete = await request(app).delete(`/api/groups/${new Types.ObjectId()}`).set('Authorization', authorization);
      const invalid = await request(app).delete('/api/groups/pas-un-id').set('Authorization', authorization);

      expect(missingUpdate.status).toBe(404);
      expect(missingDelete.status).toBe(404);
      expect(invalid.status).toBe(400);
    });
  });

  describe('groupes — lecture publique', () => {
    it('liste les groupes filtrés avec la pagination unifiée', async () => {
      await KpopGroup.insertMany([
        { name: 'aespa', genres: ['k-pop'] },
        { name: 'BLACKPINK', genres: ['k-pop'] },
        { name: 'Jazz band', genres: ['jazz'] }
      ]);

      const res = await request(app).get('/api/groups').query({ genre: 'k-pop', limit: 1 });

      expect(res.status).toBe(200);
      expect(res.body.groups).toHaveLength(1);
      expect(res.body.pagination).toEqual({ page: 1, limit: 1, total: 2, pages: 2 });
    });

    it('détaille un groupe sans exposer ses abonnés', async () => {
      const follower = await createTestUser();
      const group = await KpopGroup.create({ name: 'TXT', followers: [follower._id], followersCount: 1 });
      await Album.create({ name: 'The Dream Chapter', artistId: group._id, artistName: group.name, totalTracks: 5 });

      const res = await request(app).get(`/api/groups/${group._id}`);

      expect(res.status).toBe(200);
      expect(res.body.group.followers).toBeUndefined();
      expect(res.body.albums).toHaveLength(1);
      expect(res.body.stats).toMatchObject({ totalAlbums: 1, totalTracks: 5 });
    });

    it('répond 404 pour un groupe inexistant et 400 à une recherche sans texte', async () => {
      const missing = await request(app).get(`/api/groups/${new Types.ObjectId()}`);
      const emptySearch = await request(app).get('/api/groups/search');

      expect(missing.status).toBe(404);
      expect(emptySearch.status).toBe(400);
      expect(emptySearch.body.code).toBe('SEARCH_QUERY_REQUIRED');
    });
  });

  describe('groupes — suivi', () => {
    it('suit puis ne suit plus un groupe, compteurs à jour des deux côtés', async () => {
      const fan = await createTestUser();
      const group = await KpopGroup.create({ name: 'NMIXX' });

      const follow = await request(app).post(`/api/groups/${group._id}/follow`).set('Authorization', auth(fan));
      expect(follow.status).toBe(200);
      expect(follow.body).toEqual({ message: 'Vous suivez maintenant ce groupe', isFollowing: true, followersCount: 1 });
      expect((await User.findById(fan._id).lean())?.followedGroups?.map(String)).toEqual([String(group._id)]);

      const unfollow = await request(app).post(`/api/groups/${group._id}/follow`).set('Authorization', auth(fan));
      expect(unfollow.body).toEqual({ message: 'Vous ne suivez plus ce groupe', isFollowing: false, followersCount: 0 });
    });

    it('indique le statut de suivi et liste les groupes suivis avec la pagination unifiée', async () => {
      const fan = await createTestUser();
      const group = await KpopGroup.create({ name: 'Kep1er' });
      await request(app).post(`/api/groups/${group._id}/follow`).set('Authorization', auth(fan));

      const status = await request(app).get(`/api/groups/${group._id}/follow-status`).set('Authorization', auth(fan));
      const followed = await request(app).get('/api/groups/my-followed').set('Authorization', auth(fan));
      const followers = await request(app).get(`/api/groups/${group._id}/followers`);

      expect(status.body).toEqual({ groupId: String(group._id), groupName: 'Kep1er', isFollowing: true, followersCount: 1 });
      expect(followed.body.groups.map((g: { name: string }) => g.name)).toEqual(['Kep1er']);
      expect(followed.body.pagination).toEqual({ page: 1, limit: 20, total: 1, pages: 1 });
      expect(followers.body.followers).toHaveLength(1);
      expect(followers.body.followers[0].email).toBeUndefined();
      expect(followers.body.pagination).toEqual({ page: 1, limit: 20, total: 1, pages: 1 });
    });

    it('répond 404 au suivi d\'un groupe inexistant et 400 à un identifiant invalide', async () => {
      const fan = await createTestUser();

      const missing = await request(app).post(`/api/groups/${new Types.ObjectId()}/follow`).set('Authorization', auth(fan));
      const invalid = await request(app).post('/api/groups/pas-un-id/follow').set('Authorization', auth(fan));

      expect(missing.status).toBe(404);
      expect(missing.body.message).toBe('Groupe non trouvé');
      expect(invalid.status).toBe(400);
    });

    it('exige une authentification pour suivre', async () => {
      const group = await KpopGroup.create({ name: 'fromis_9' });
      const res = await request(app).post(`/api/groups/${group._id}/follow`);
      expect(res.status).toBe(401);
    });
  });

  describe('albums', () => {
    async function seedAlbums() {
      const group = await KpopGroup.create({ name: 'Red Velvet' });
      await Album.create([
        { name: 'The Red', artistId: group._id, artistName: group.name, totalTracks: 10, releaseDate: new Date('2015-09-09') },
        { name: 'Feel My Rhythm', artistId: group._id, artistName: group.name, totalTracks: 6, releaseDate: new Date('2022-03-21') }
      ]);
      return group;
    }

    it('liste les albums filtrés par année, avec la pagination unifiée', async () => {
      await seedAlbums();

      const res = await request(app).get('/api/albums').query({ year: '2022' });

      expect(res.status).toBe(200);
      expect(res.body.albums.map((album: { name: string }) => album.name)).toEqual(['Feel My Rhythm']);
      expect(res.body.pagination).toEqual({ page: 1, limit: 20, total: 1, pages: 1 });
    });

    it('filtre par nombre minimal de pistes et ignore un filtre numérique invalide', async () => {
      await seedAlbums();

      const filtered = await request(app).get('/api/albums').query({ minTracks: '8' });
      const ignored = await request(app).get('/api/albums').query({ minTracks: 'beaucoup' });

      expect(filtered.body.albums.map((album: { name: string }) => album.name)).toEqual(['The Red']);
      expect(ignored.body.pagination.total).toBe(2);
    });

    it('refuse (400) un artistId mal formé', async () => {
      const res = await request(app).get('/api/albums').query({ artistId: 'pas-un-id' });
      expect(res.status).toBe(400);
    });

    it('liste les albums d\'un groupe, ou un message quand il n\'en a pas', async () => {
      const group = await seedAlbums();
      const emptyGroup = await KpopGroup.create({ name: 'Sans album' });

      const withAlbums = await request(app).get(`/api/albums/group/${group._id}`);
      const empty = await request(app).get(`/api/albums/group/${emptyGroup._id}`);

      expect(withAlbums.body.albums).toHaveLength(2);
      expect(empty.body).toEqual({ albums: [], message: 'Aucun album trouvé pour ce groupe' });
    });

    it('recherche par nom ou artiste, et refuse une recherche vide', async () => {
      await seedAlbums();

      const found = await request(app).get('/api/albums/search').query({ query: 'rhythm' });
      const empty = await request(app).get('/api/albums/search');

      expect(found.body).toMatchObject({ query: 'rhythm', found: 1 });
      expect(empty.status).toBe(400);
    });

    it('détaille un album, 404 s\'il n\'existe pas', async () => {
      await seedAlbums();
      const album = await Album.findOne({ name: 'The Red' });

      const found = await request(app).get(`/api/albums/${album!._id}`);
      const missing = await request(app).get(`/api/albums/${new Types.ObjectId()}`);

      expect(found.status).toBe(200);
      expect(found.body.stats).toMatchObject({ totalTracks: 10, releaseYear: 2015, totalProducts: 0 });
      expect(missing.status).toBe(404);
    });

    it('supprime un album (admin), 404 s\'il n\'existe plus', async () => {
      await seedAlbums();
      const album = await Album.findOne({ name: 'The Red' });
      const authorization = await adminAuth();

      const deleted = await request(app).delete(`/api/albums/${album!._id}`).set('Authorization', authorization);
      const again = await request(app).delete(`/api/albums/${album!._id}`).set('Authorization', authorization);

      expect(deleted.status).toBe(200);
      expect(again.status).toBe(404);
    });

    it('réserve la suppression aux administrateurs', async () => {
      await seedAlbums();
      const album = await Album.findOne();

      const res = await request(app).delete(`/api/albums/${album!._id}`).set('Authorization', auth(await createTestUser()));

      expect(res.status).toBe(403);
      expect(await Album.countDocuments()).toBe(2);
    });
  });
});
