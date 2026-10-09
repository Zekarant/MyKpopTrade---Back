import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import sharp from 'sharp';
import { storedUpload, reencodeImage } from '../storedUpload';
import { HttpError } from '../../utils/httpError';

/** Photo de téléphone : JPEG portant des métadonnées EXIF (appareil, GPS). */
async function jpegWithExif(): Promise<Buffer> {
  return sharp({ create: { width: 4, height: 2, channels: 3, background: 'red' } })
    .jpeg()
    .withExif({ IFD0: { Make: 'Telephone' }, IFD3: { GPSLatitudeRef: 'N' } })
    .toBuffer();
}

describe('reencodeImage', () => {
  it('retire les métadonnées EXIF d\'une photo', async () => {
    const source = await jpegWithExif();
    expect((await sharp(source).metadata()).exif).toBeDefined();

    const result = await reencodeImage(source);

    expect((await sharp(result.buffer).metadata()).exif).toBeUndefined();
    expect(result).toMatchObject({ extension: '.jpg', mimetype: 'image/jpeg' });
  });

  it('retient le format décodé, pas celui annoncé par le client', async () => {
    const png = await sharp({ create: { width: 1, height: 1, channels: 4, background: 'blue' } }).png().toBuffer();

    expect(await reencodeImage(png)).toMatchObject({ extension: '.png', mimetype: 'image/png' });
  });

  it('refuse (400) un contenu qui n\'est pas une image', async () => {
    await expect(reencodeImage(Buffer.from('<script>alert(1)</script>'))).rejects.toMatchObject({ statusCode: 400 });
  });

  it('refuse (400) un format d\'image hors liste, comme le SVG', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>');

    await expect(reencodeImage(svg)).rejects.toBeInstanceOf(HttpError);
  });
});

describe('storedUpload', () => {
  let directory: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stored-upload-'));
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function appWith(maxFiles = 2) {
    const upload = storedUpload({
      directory,
      allowedMimeTypes: ['image/png', 'image/jpeg'],
      rejectedTypeMessage: 'Type refusé',
      maxFileSize: 1024 * 1024,
      maxFiles,
      filename: (_req, extension) => `${Math.random().toString(36).slice(2)}${extension}`,
      prepare: (file) => reencodeImage(file.buffer)
    });
    const app = express();
    app.post('/upload', upload.array('images', maxFiles), (req, res) => {
      const files = req.files as Express.Multer.File[];
      res.json({ files: files.map(({ filename, path: filePath, mimetype }) => ({ filename, path: filePath, mimetype })) });
    });
    app.use((error: HttpError, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(error.statusCode ?? 500).json({ message: error.message });
    });
    return app;
  }

  it('écrit l\'image ré-encodée, sans EXIF, sous l\'extension de son format', async () => {
    const res = await request(appWith())
      .post('/upload')
      .attach('images', await jpegWithExif(), { filename: 'photo.png', contentType: 'image/png' });

    expect(res.status).toBe(200);
    const [stored] = res.body.files;
    expect(stored.filename).toMatch(/\.jpg$/);
    expect(stored.mimetype).toBe('image/jpeg');
    expect((await sharp(fs.readFileSync(stored.path)).metadata()).exif).toBeUndefined();
  });

  it('refuse (400) un faux fichier image et n\'écrit rien, même pas les images valides du même envoi', async () => {
    const png = await sharp({ create: { width: 1, height: 1, channels: 4, background: 'blue' } }).png().toBuffer();

    const res = await request(appWith())
      .post('/upload')
      .attach('images', png, { filename: 'ok.png', contentType: 'image/png' })
      .attach('images', Buffer.from('<html>piège</html>'), { filename: 'x.png', contentType: 'image/png' });

    expect(res.status).toBe(400);
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it('refuse (400) un type déclaré hors liste', async () => {
    const res = await request(appWith())
      .post('/upload')
      .attach('images', Buffer.from('%PDF-1.7'), { filename: 'doc.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Type refusé');
  });

  it('refuse (400) un envoi qui dépasse le nombre de champs texte autorisé', async () => {
    let req = request(appWith()).post('/upload');
    for (let i = 0; i < 25; i++) req = req.field(`champ${i}`, 'x');

    const res = await req;

    expect(res.status).toBe(400);
  });
});
