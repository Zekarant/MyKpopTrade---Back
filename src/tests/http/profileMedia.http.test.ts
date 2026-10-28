import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { Types } from 'mongoose';
import { createApp } from '../../app';
import { startInMemoryMongo, stopInMemoryMongo, clearAllCollections } from '../helpers/mongoMemory';
import { createTestUser } from '../helpers/fixtures';
import { generateAccessToken } from '../../commons/services/tokenService';
import Rating from '../../models/ratingModel';
import User from '../../models/userModel';

/** Photo de profil, bannière, images des avis et réponses du destinataire. */
const app = createApp();

const UPLOAD_DIRS = ['profiles', 'banners', 'ratings'].map((dir) => path.join(process.cwd(), 'uploads', dir));

// PNG 1×1 valide (les images envoyées sont décodées puis ré-encodées par l'API).
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWNgYPj/HwADAgH/xCAAOgAAAABJRU5ErkJggg==',
  'base64'
);

type TestUser = Awaited<ReturnType<typeof createTestUser>>;

const auth = (user: TestUser) => `Bearer ${generateAccessToken(user)}`;

const listUploads = () =>
  UPLOAD_DIRS.flatMap((dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).map((file) => path.join(dir, file)) : []));

const fileOnDisk = (publicPath: string) => fs.existsSync(path.join(process.cwd(), publicPath));

const createRating = (reviewer: TestUser, recipient: TestUser, overrides: Record<string, unknown> = {}) =>
  Rating.create({
    reviewer: reviewer._id,
    recipient: recipient._id,
    rating: 5,
    review: 'Envoi rapide, très bien emballé',
    type: 'seller',
    ...overrides
  });

/** Document tel qu'il est stocké, sans les valeurs par défaut que Mongoose ajoute au chargement. */
const storedRating = (ratingId: unknown) => Rating.collection.findOne({ _id: ratingId as Types.ObjectId });

const addRatingImage = (ratingId: unknown, user: TestUser) =>
  request(app)
    .post(`/api/profiles/ratings/${ratingId}/images`)
    .set('Authorization', auth(user))
    .attach('ratingImage', PNG, { filename: 'colis.png', contentType: 'image/png' });

describe('HTTP — médias du profil et des avis', () => {
  let uploadsBefore: Set<string>;

  beforeAll(async () => {
    await startInMemoryMongo();
  }, 60000);

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  beforeEach(async () => {
    await clearAllCollections();
    uploadsBefore = new Set(listUploads());
  });

  afterEach(() => {
    for (const file of listUploads()) {
      if (!uploadsBefore.has(file)) fs.rmSync(file, { force: true });
    }
  });

  const newUploads = () => listUploads().filter((file) => !uploadsBefore.has(file));

  describe.each([
    { route: 'picture', field: 'profilePicture', dir: 'profiles' },
    { route: 'banner', field: 'profileBanner', dir: 'banners' }
  ] as const)('/api/profiles/me/$route', ({ route, field, dir }) => {
    const upload = (user: TestUser) =>
      request(app)
        .post(`/api/profiles/me/${route}`)
        .set('Authorization', auth(user))
        .attach(field, PNG, { filename: 'photo.png', contentType: 'image/png' });

    it('remplace l\'image et efface l\'ancien fichier', async () => {
      const user = await createTestUser();
      const first = await upload(user);

      const second = await upload(user);

      expect(second.status).toBe(200);
      expect(second.body[field]).toMatch(new RegExp(`^/uploads/${dir}/`));
      expect((await User.findById(user._id))![field]).toBe(second.body[field]);
      expect(fileOnDisk(first.body[field])).toBe(false);
      expect(fileOnDisk(second.body[field])).toBe(true);
    });

    it('refuse (400) une requête sans fichier', async () => {
      const user = await createTestUser();

      const res = await request(app).post(`/api/profiles/me/${route}`).set('Authorization', auth(user));

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('NO_FILE_UPLOADED');
    });

    it('revient à l\'image par défaut et efface le fichier', async () => {
      const user = await createTestUser();
      const uploaded = await upload(user);

      const res = await request(app).delete(`/api/profiles/me/${route}`).set('Authorization', auth(user));

      expect(res.status).toBe(200);
      expect((await User.findById(user._id))![field]).toEqual(new User()[field]);
      expect(fileOnDisk(uploaded.body[field])).toBe(false);
    });
  });

  // La photo de profil a un avatar par défaut : seule la bannière peut être absente.
  it('refuse (400) la suppression d\'une bannière absente', async () => {
    const user = await createTestUser();

    const res = await request(app).delete('/api/profiles/me/banner').set('Authorization', auth(user));

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NO_PROFILE_IMAGE');
  });

  describe('/api/profiles/ratings/:ratingId/images', () => {
    it('ajoute une image à l\'avis de son auteur', async () => {
      const [reviewer, seller] = [await createTestUser(), await createTestUser()];
      const rating = await createRating(reviewer, seller);

      const res = await addRatingImage(rating._id, reviewer);

      expect(res.status).toBe(200);
      expect(res.body.images).toEqual([res.body.image]);
      expect(fileOnDisk(res.body.image)).toBe(true);
    });

    it('refuse (403) un autre membre et efface le fichier reçu', async () => {
      const [reviewer, seller] = [await createTestUser(), await createTestUser()];
      const rating = await createRating(reviewer, seller);

      const res = await addRatingImage(rating._id, seller);

      expect(res.status).toBe(403);
      expect(newUploads()).toEqual([]);
    });

    it('refuse (400) une 6e image et efface le fichier reçu', async () => {
      const [reviewer, seller] = [await createTestUser(), await createTestUser()];
      const images = Array.from({ length: 5 }, (_, i) => `/uploads/ratings/existante-${i}.png`);
      const rating = await createRating(reviewer, seller, { images });

      const res = await addRatingImage(rating._id, reviewer);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('MAX_IMAGES_REACHED');
      expect(newUploads()).toEqual([]);
    });

    it('retire l\'image demandée et son fichier', async () => {
      const [reviewer, seller] = [await createTestUser(), await createTestUser()];
      const rating = await createRating(reviewer, seller);
      const { image } = (await addRatingImage(rating._id, reviewer)).body;

      const res = await request(app)
        .delete(`/api/profiles/ratings/${rating._id}/images`)
        .set('Authorization', auth(reviewer))
        .send({ imageIndex: 0 });

      expect(res.status).toBe(200);
      expect(res.body.images).toEqual([]);
      expect(fileOnDisk(image)).toBe(false);
    });

    it('refuse (400) un index hors limites', async () => {
      const [reviewer, seller] = [await createTestUser(), await createTestUser()];
      const rating = await createRating(reviewer, seller);

      const res = await request(app)
        .delete(`/api/profiles/ratings/${rating._id}/images`)
        .set('Authorization', auth(reviewer))
        .send({ imageIndex: 0 });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_IMAGE_INDEX');
    });
  });

  describe('/api/profiles/ratings/:ratingId/response', () => {
    const respond = (method: 'post' | 'put' | 'delete', ratingId: unknown, user: TestUser, response?: string) =>
      request(app)[method](`/api/profiles/ratings/${ratingId}/response`)
        .set('Authorization', auth(user))
        .send(response === undefined ? {} : { response });

    it('laisse le destinataire répondre, modifier puis supprimer sa réponse', async () => {
      const [reviewer, seller] = [await createTestUser(), await createTestUser()];
      const rating = await createRating(reviewer, seller);

      const created = await respond('post', rating._id, seller, '  Merci pour votre achat !  ');
      const updated = await respond('put', rating._id, seller, 'Merci, à bientôt');
      const deleted = await respond('delete', rating._id, seller);

      expect(created.status).toBe(200);
      expect(created.body.rating.response.content).toBe('Merci pour votre achat !');
      expect(updated.body.rating.response.content).toBe('Merci, à bientôt');
      expect(deleted.status).toBe(200);
      expect((await storedRating(rating._id))!.response).toBeUndefined();
    });

    it('n\'enregistre aucune réponse vide sur un avis sans réponse', async () => {
      const [reviewer, seller] = [await createTestUser(), await createTestUser()];
      const rating = await createRating(reviewer, seller);

      await addRatingImage(rating._id, reviewer);

      expect((await storedRating(rating._id))!.response).toBeUndefined();
    });

    it('refuse (403) une réponse de l\'auteur de l\'avis', async () => {
      const [reviewer, seller] = [await createTestUser(), await createTestUser()];
      const rating = await createRating(reviewer, seller);

      const res = await respond('post', rating._id, reviewer, 'Je me réponds');

      expect(res.status).toBe(403);
    });

    it('refuse (400) une deuxième réponse', async () => {
      const [reviewer, seller] = [await createTestUser(), await createTestUser()];
      const rating = await createRating(reviewer, seller, { response: { content: 'Merci', createdAt: new Date() } });

      const res = await respond('post', rating._id, seller, 'Encore merci');

      expect(res.status).toBe(400);
    });

    it('refuse (400) une réponse de plus de 500 caractères', async () => {
      const [reviewer, seller] = [await createTestUser(), await createTestUser()];
      const rating = await createRating(reviewer, seller);

      const res = await respond('post', rating._id, seller, 'a'.repeat(501));

      expect(res.status).toBe(400);
    });

    it('refuse (400) la modification d\'une réponse inexistante', async () => {
      const [reviewer, seller] = [await createTestUser(), await createTestUser()];
      const rating = await createRating(reviewer, seller);

      const res = await respond('put', rating._id, seller, 'Merci');

      expect(res.status).toBe(400);
    });

    it('répond 404 pour un avis inconnu', async () => {
      const seller = await createTestUser();

      const res = await respond('post', '0123456789abcdef01234567', seller, 'Merci');

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('RATING_NOT_FOUND');
    });
  });
});
