import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { createApp } from '../../app';
import { startInMemoryMongo, stopInMemoryMongo, clearAllCollections } from '../helpers/mongoMemory';
import { createTestUser } from '../helpers/fixtures';
import { generateAccessToken } from '../../commons/services/tokenService';
import Post from '../../modules/posts/model';

/** Publications du fil : images affichables, entrées validées, compteurs justes. */
const app = createApp();

// PNG 1×1 valide (les images envoyées sont décodées puis ré-encodées par l'API).
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWNgYPj/HwADAgH/xCAAOgAAAABJRU5ErkJggg==',
  'base64'
);

describe('HTTP — publications', () => {
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

  it('enregistre les images sous un chemin réellement servi', async () => {
    const author = await createTestUser();

    const res = await request(app)
      .post('/api/posts')
      .set('Authorization', auth(author))
      .field('content', 'Nouvel arrivage')
      .attach('postImages', PNG, { filename: 'photo.png', contentType: 'image/png' });

    expect(res.status).toBe(201);
    const [image] = res.body.post.images as string[];
    expect(image).toMatch(/^\/uploads\/products\//);
    try {
      const served = await request(app).get(image);
      expect(served.status).toBe(200);
    } finally {
      fs.rmSync(path.join(process.cwd(), image), { force: true });
    }
  });

  it('refuse un contenu qui n\'est pas du texte au lieu de répondre 500', async () => {
    const author = await createTestUser();

    const res = await request(app)
      .post('/api/posts')
      .set('Authorization', auth(author))
      .send({ content: { $gt: '' } });

    expect(res.status).toBe(400);
  });

  it('plafonne la taille de page demandée', async () => {
    const author = await createTestUser();

    const res = await request(app).get(`/api/posts/user/${author._id}?limit=100000`);

    expect(res.status).toBe(200);
    expect(res.body.pagination.limit).toBe(50);
  });

  it('compte chaque « j\'aime » simultané, une seule fois par personne', async () => {
    const author = await createTestUser();
    const post = await Post.create({ author: author._id, content: 'Salut' });
    const fans = await Promise.all(Array.from({ length: 5 }, () => createTestUser()));

    await Promise.all(fans.map((fan) => request(app).post(`/api/posts/${post._id}/like`).set('Authorization', auth(fan))));

    const liked = await Post.findById(post._id);
    expect(liked!.likesCount).toBe(5);
    expect(liked!.likes).toHaveLength(5);
  });

  it('retire le « j\'aime » au second clic', async () => {
    const author = await createTestUser();
    const post = await Post.create({ author: author._id, content: 'Salut' });

    await request(app).post(`/api/posts/${post._id}/like`).set('Authorization', auth(author));
    const second = await request(app).post(`/api/posts/${post._id}/like`).set('Authorization', auth(author));

    expect(second.body).toEqual({ liked: false, likesCount: 0 });
  });

  it('compte les réponses simultanées', async () => {
    const author = await createTestUser();
    const post = await Post.create({ author: author._id, content: 'Question ?' });
    const repliers = await Promise.all(Array.from({ length: 4 }, () => createTestUser()));

    await Promise.all(repliers.map((user) =>
      request(app).post(`/api/posts/${post._id}/reply`).set('Authorization', auth(user)).send({ content: 'Oui' })
    ));

    expect((await Post.findById(post._id))!.repliesCount).toBe(4);
  });

  it('répond 404, pas 500, pour un identifiant invalide', async () => {
    const res = await request(app).get('/api/posts/pas-un-id');

    expect(res.status).toBe(404);
  });
});
