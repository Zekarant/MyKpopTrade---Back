import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { createApp } from '../../app';
import { startInMemoryMongo, stopInMemoryMongo, clearAllCollections } from '../helpers/mongoMemory';
import { createTestUser } from '../helpers/fixtures';
import { generateAccessToken } from '../../commons/services/tokenService';
import Post from '../../models/postModel';
import Follow from '../../models/followModel';

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

  it('crée un post texte avec son auteur', async () => {
    const author = await createTestUser();

    const res = await request(app).post('/api/posts').set('Authorization', auth(author)).send({ content: '  Bonjour  ' });

    expect(res.status).toBe(201);
    expect(res.body.post).toMatchObject({ content: 'Bonjour', images: [], author: { username: author.username } });
    expect(res.body.post.author).not.toHaveProperty('email');
  });

  it('montre au membre connecté ses posts et ceux des membres suivis, sans les réponses', async () => {
    const me = await createTestUser();
    const followed = await createTestUser();
    const stranger = await createTestUser();
    await Follow.create({ follower: me._id, following: followed._id });
    const mine = await Post.create({ author: me._id, content: 'Le mien' });
    await Post.create({ author: followed._id, content: 'Suivi' });
    await Post.create({ author: stranger._id, content: 'Inconnu' });
    await Post.create({ author: followed._id, content: 'Réponse', isReply: true, parentPost: mine._id });

    const res = await request(app).get('/api/posts/feed').set('Authorization', auth(me));

    expect(res.status).toBe(200);
    expect(res.body.posts.map((post: { content: string }) => post.content).sort()).toEqual(['Le mien', 'Suivi']);
    expect(res.body.pagination).toEqual({ page: 1, limit: 20, total: 2, pages: 1 });
  });

  it('liste les posts d\'un membre avec le format unique de pagination', async () => {
    const author = await createTestUser();
    await Post.create([1, 2, 3].map((n) => ({ author: author._id, content: `Post ${n}` })));

    const res = await request(app).get(`/api/posts/user/${author._id}?limit=2&page=2`);

    expect(res.body.posts).toHaveLength(1);
    expect(res.body.pagination).toEqual({ page: 2, limit: 2, total: 3, pages: 2 });
  });

  it('refuse (400) un identifiant de membre invalide', async () => {
    const res = await request(app).get('/api/posts/user/pas-un-id');

    expect(res.status).toBe(400);
  });

  it('renvoie un post avec ses réponses dans l\'ordre chronologique', async () => {
    const author = await createTestUser();
    const replier = await createTestUser();
    const post = await Post.create({ author: author._id, content: 'Question ?' });
    await request(app).post(`/api/posts/${post._id}/reply`).set('Authorization', auth(replier)).send({ content: 'Première' });
    await request(app).post(`/api/posts/${post._id}/reply`).set('Authorization', auth(author)).send({ content: 'Seconde' });

    const res = await request(app).get(`/api/posts/${post._id}`);

    expect(res.status).toBe(200);
    expect(res.body.post.repliesCount).toBe(2);
    expect(res.body.replies.map((reply: { content: string }) => reply.content)).toEqual(['Première', 'Seconde']);
    expect(res.body.pagination.total).toBe(2);
  });

  it('répond 404 à une réponse sur un post inexistant et 400 à une réponse vide', async () => {
    const user = await createTestUser();
    const post = await Post.create({ author: user._id, content: 'Salut' });

    const missing = await request(app)
      .post('/api/posts/507f1f77bcf86cd799439011/reply')
      .set('Authorization', auth(user))
      .send({ content: 'Oui' });
    const empty = await request(app).post(`/api/posts/${post._id}/reply`).set('Authorization', auth(user)).send({ content: ' ' });

    expect(missing.status).toBe(404);
    expect(empty.status).toBe(400);
  });

  it('supprime un post et ses réponses, pour son seul auteur', async () => {
    const author = await createTestUser();
    const other = await createTestUser();
    const post = await Post.create({ author: author._id, content: 'Salut' });
    await Post.create({ author: other._id, content: 'Réponse', isReply: true, parentPost: post._id });

    const refused = await request(app).delete(`/api/posts/${post._id}`).set('Authorization', auth(other));
    const deleted = await request(app).delete(`/api/posts/${post._id}`).set('Authorization', auth(author));

    expect(refused.status).toBe(403);
    expect(deleted.status).toBe(200);
    expect(await Post.countDocuments()).toBe(0);
  });

  it('décrémente le compteur du post parent quand une réponse est supprimée', async () => {
    const author = await createTestUser();
    const post = await Post.create({ author: author._id, content: 'Question ?' });
    const { body } = await request(app)
      .post(`/api/posts/${post._id}/reply`)
      .set('Authorization', auth(author))
      .send({ content: 'Réponse' });

    await request(app).delete(`/api/posts/${body.post._id}`).set('Authorization', auth(author));

    expect((await Post.findById(post._id))!.repliesCount).toBe(0);
  });
});
