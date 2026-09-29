import express from 'express';
import multer from 'multer';
import request from 'supertest';
import { sanitizedMulter } from '../sanitizedMulter';

/**
 * multer interprète la notation à crochets des champs texte : sans nettoyage,
 * `username[$ne]=x` arrive au contrôleur sous la forme `{ $ne: 'x' }`.
 */
function appWith(middleware: express.RequestHandler) {
  const app = express();
  app.post('/upload', middleware, (req, res) => {
    res.json({ body: req.body, fileCount: Array.isArray(req.files) ? req.files.length : req.file ? 1 : 0 });
  });
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(400).json({ message: error.message });
  });
  return app;
}

const upload = sanitizedMulter({ storage: multer.memoryStorage() });

describe('sanitizedMulter', () => {
  it('retire les opérateurs Mongo des champs texte multipart', async () => {
    const res = await request(appWith(upload.single('document')))
      .post('/upload')
      .field('username[$ne]', 'x')
      .field('bio', 'Bonjour')
      .attach('document', Buffer.from('fichier'), 'a.png');

    expect(res.status).toBe(200);
    expect(res.body.body).toEqual({ username: {}, bio: 'Bonjour' });
    expect(res.body.fileCount).toBe(1);
  });

  it('nettoie aussi les envois multiples', async () => {
    const res = await request(appWith(upload.array('images', 2)))
      .post('/upload')
      .field('filter[$gt]', '')
      .attach('images', Buffer.from('1'), '1.png')
      .attach('images', Buffer.from('2'), '2.png');

    expect(res.body.body).toEqual({ filter: {} });
    expect(res.body.fileCount).toBe(2);
  });

  it('transmet les erreurs de multer sans les masquer', async () => {
    const limited = sanitizedMulter({ storage: multer.memoryStorage(), limits: { fileSize: 1 } });

    const res = await request(appWith(limited.single('document')))
      .post('/upload')
      .attach('document', Buffer.from('trop gros'), 'a.png');

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('File too large');
  });
});
