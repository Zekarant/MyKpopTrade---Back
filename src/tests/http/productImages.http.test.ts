import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { createApp } from '../../app';
import { startInMemoryMongo, stopInMemoryMongo, clearAllCollections } from '../helpers/mongoMemory';
import { createTestUser, createTestProduct } from '../helpers/fixtures';
import { generateAccessToken } from '../../commons/services/tokenService';
import Product from '../../models/productModel';

/** Images d'une annonce : ajout, retrait et ordre, par son seul vendeur. */
const app = createApp();

const PRODUCT_UPLOADS_DIR = path.join(process.cwd(), 'uploads/products');

// PNG 1×1 valide (les images envoyées sont décodées puis ré-encodées par l'API).
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWNgYPj/HwADAgH/xCAAOgAAAABJRU5ErkJggg==',
  'base64'
);

const listUploads = () => (fs.existsSync(PRODUCT_UPLOADS_DIR) ? fs.readdirSync(PRODUCT_UPLOADS_DIR) : []);

describe('HTTP — images des annonces', () => {
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
      if (!uploadsBefore.has(file)) fs.rmSync(path.join(PRODUCT_UPLOADS_DIR, file), { force: true });
    }
  });

  const auth = (user: Awaited<ReturnType<typeof createTestUser>>) => `Bearer ${generateAccessToken(user)}`;
  const newUploads = () => listUploads().filter((file) => !uploadsBefore.has(file));

  const upload = (productId: unknown, user: Awaited<ReturnType<typeof createTestUser>>) =>
    request(app)
      .post(`/api/products/${productId}/images`)
      .set('Authorization', auth(user))
      .attach('productImage', PNG, { filename: 'photo.png', contentType: 'image/png' });

  describe('POST /api/products/:productId/images', () => {
    it('ajoute l\'image à l\'annonce du vendeur', async () => {
      const seller = await createTestUser();
      const product = await createTestProduct(seller._id);

      const res = await upload(product._id, seller);

      expect(res.status).toBe(200);
      expect(res.body.image).toMatch(/^\/uploads\/products\//);
      expect(res.body.images).toEqual(['/uploads/products/test.jpg', res.body.image]);
      expect((await Product.findById(product._id))!.images).toHaveLength(2);
    });

    it('refuse (403) un autre membre et efface le fichier reçu', async () => {
      const seller = await createTestUser();
      const intruder = await createTestUser();
      const product = await createTestProduct(seller._id);

      const res = await upload(product._id, intruder);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
      expect(newUploads()).toEqual([]);
    });

    it('refuse (400) au-delà de 10 images et efface le fichier reçu', async () => {
      const seller = await createTestUser();
      const product = await createTestProduct(seller._id, {
        images: Array.from({ length: 10 }, (_, i) => `/uploads/products/p${i}.jpg`)
      });

      const res = await upload(product._id, seller);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('PRODUCT_IMAGE_LIMIT_REACHED');
      expect(newUploads()).toEqual([]);
    });

    it('répond 404 pour une annonce inexistante, 400 pour un identifiant invalide', async () => {
      const seller = await createTestUser();

      const missing = await upload('507f1f77bcf86cd799439011', seller);
      const invalid = await upload('pas-un-id', seller);

      expect(missing.status).toBe(404);
      expect(invalid.status).toBe(400);
      expect(newUploads()).toEqual([]);
    });

    it('refuse (400) une requête sans image', async () => {
      const seller = await createTestUser();
      const product = await createTestProduct(seller._id);

      const res = await request(app).post(`/api/products/${product._id}/images`).set('Authorization', auth(seller));

      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /api/products/:productId/images', () => {
    it('retire l\'image demandée', async () => {
      const seller = await createTestUser();
      const product = await createTestProduct(seller._id, {
        images: ['/uploads/products/a.jpg', '/uploads/products/b.jpg']
      });

      const res = await request(app)
        .delete(`/api/products/${product._id}/images`)
        .set('Authorization', auth(seller))
        .send({ imageIndex: 0 });

      expect(res.status).toBe(200);
      expect(res.body.images).toEqual(['/uploads/products/b.jpg']);
    });

    it('efface du disque le fichier de l\'image retirée', async () => {
      const seller = await createTestUser();
      const product = await createTestProduct(seller._id);
      const { body } = await upload(product._id, seller);

      await request(app)
        .delete(`/api/products/${product._id}/images`)
        .set('Authorization', auth(seller))
        .send({ imageIndex: 1 });

      expect(fs.existsSync(path.join(process.cwd(), body.image))).toBe(false);
    });

    it('refuse (400) de retirer la dernière image', async () => {
      const seller = await createTestUser();
      const product = await createTestProduct(seller._id);

      const res = await request(app)
        .delete(`/api/products/${product._id}/images`)
        .set('Authorization', auth(seller))
        .send({ imageIndex: 0 });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('LAST_PRODUCT_IMAGE');
    });

    it.each([[-1], [5], ['0'], [0.5]])('refuse (400) l\'index %p', async (imageIndex) => {
      const seller = await createTestUser();
      const product = await createTestProduct(seller._id, {
        images: ['/uploads/products/a.jpg', '/uploads/products/b.jpg']
      });

      const res = await request(app)
        .delete(`/api/products/${product._id}/images`)
        .set('Authorization', auth(seller))
        .send({ imageIndex });

      expect(res.status).toBe(400);
    });

    it('refuse (403) un autre membre', async () => {
      const seller = await createTestUser();
      const intruder = await createTestUser();
      const product = await createTestProduct(seller._id, {
        images: ['/uploads/products/a.jpg', '/uploads/products/b.jpg']
      });

      const res = await request(app)
        .delete(`/api/products/${product._id}/images`)
        .set('Authorization', auth(intruder))
        .send({ imageIndex: 0 });

      expect(res.status).toBe(403);
      expect((await Product.findById(product._id))!.images).toHaveLength(2);
    });
  });

  describe('PUT /api/products/:productId/images/reorder', () => {
    const images = ['/uploads/products/a.jpg', '/uploads/products/b.jpg', '/uploads/products/c.jpg'];

    it('réordonne les images', async () => {
      const seller = await createTestUser();
      const product = await createTestProduct(seller._id, { images });

      const res = await request(app)
        .put(`/api/products/${product._id}/images/reorder`)
        .set('Authorization', auth(seller))
        .send({ imageOrder: [2, 0, 1] });

      expect(res.status).toBe(200);
      expect(res.body.images).toEqual([images[2], images[0], images[1]]);
    });

    it.each([
      ['un format invalide', 'abc'],
      ['un ordre trop court', [0, 1]],
      ['un index hors limites', [0, 1, 3]],
      ['un doublon', [0, 0, 1]]
    ])('refuse (400) %s', async (_label, imageOrder) => {
      const seller = await createTestUser();
      const product = await createTestProduct(seller._id, { images });

      const res = await request(app)
        .put(`/api/products/${product._id}/images/reorder`)
        .set('Authorization', auth(seller))
        .send({ imageOrder });

      expect(res.status).toBe(400);
      expect((await Product.findById(product._id))!.images).toEqual(images);
    });
  });
});
