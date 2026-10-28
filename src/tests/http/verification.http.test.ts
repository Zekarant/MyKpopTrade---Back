jest.mock('../../commons/services/secureStorageService', () => ({
  secureStoreDocument: jest.fn().mockResolvedValue('doc-ref'),
  deleteSecureDocument: jest.fn().mockResolvedValue(undefined),
  retrieveSecureDocument: jest.fn().mockResolvedValue({ buffer: Buffer.from('image'), metadata: { type: 'image/png' } }),
  cleanExpiredDocuments: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('../../commons/services/emailService', () => ({
  ...jest.requireActual('../../commons/services/emailService'),
  sendVerificationResultEmail: jest.fn().mockResolvedValue(undefined)
}));

import request from 'supertest';
import { createApp } from '../../app';
import { startInMemoryMongo, stopInMemoryMongo, clearAllCollections } from '../helpers/mongoMemory';
import { createTestUser } from '../helpers/fixtures';
import { generateAccessToken } from '../../commons/services/tokenService';
import { deleteSecureDocument } from '../../commons/services/secureStorageService';
import User from '../../models/userModel';

/** Vérification d'identité : dépôt du document, suivi, examen par un admin. */
const app = createApp();

type TestUser = Awaited<ReturnType<typeof createTestUser>>;
const auth = (user: TestUser) => `Bearer ${generateAccessToken(user)}`;
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('photo')]);

describe('HTTP — vérification d\'identité', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 60000);

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  beforeEach(async () => {
    await clearAllCollections();
    jest.mocked(deleteSecureDocument).mockClear();
  });

  const submit = (user: TestUser, file: Buffer = JPEG) =>
    request(app)
      .post('/api/verification/identity')
      .set('Authorization', auth(user))
      .field('documentType', 'id_card')
      .field('consentGiven', 'true')
      .attach('document', file, { filename: 'id.jpg', contentType: 'image/jpeg' });

  it('enregistre une demande avec son document (201)', async () => {
    const user = await createTestUser();

    const res = await submit(user);

    expect(res.status).toBe(201);
    expect(res.body.verification).toMatchObject({ status: 'pending', documentType: 'id_card' });
  });

  it('refuse un fichier qui n\'est pas une vraie image (400)', async () => {
    const user = await createTestUser();

    const res = await submit(user, Buffer.from('%PDF-1.7 pas une image'));

    expect(res.status).toBe(400);
  });

  it('refuse une seconde demande en cours (409 VERIFICATION_PENDING)', async () => {
    const user = await createTestUser();
    await submit(user);

    const res = await submit(user);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('VERIFICATION_PENDING');
  });

  it('donne le statut de la dernière demande, 404 s\'il n\'y en a aucune', async () => {
    const user = await createTestUser();
    const status = () => request(app).get('/api/verification/identity/status').set('Authorization', auth(user));

    const before = await status();
    await submit(user);
    const after = await status();

    expect(before.status).toBe(404);
    expect(after.status).toBe(200);
    expect(after.body.verification.status).toBe('pending');
  });

  it('laisse l\'utilisateur annuler sa demande et supprime le document', async () => {
    const user = await createTestUser();
    await submit(user);

    const res = await request(app).delete('/api/verification/identity/cancel').set('Authorization', auth(user));

    expect(res.status).toBe(200);
    expect(deleteSecureDocument).toHaveBeenCalledWith('doc-ref');
  });

  describe('administration', () => {
    async function pendingRequest() {
      const user = await createTestUser();
      const admin = await createTestUser({ role: 'admin' });
      const { body } = await submit(user);
      return { user, admin, verificationId: String(body.verification.id) };
    }

    it('réserve la liste des demandes aux admins, avec la pagination unifiée', async () => {
      const { user, admin } = await pendingRequest();

      const asUser = await request(app).get('/api/verification/admin/pending').set('Authorization', auth(user));
      const asAdmin = await request(app).get('/api/verification/admin/pending').set('Authorization', auth(admin));

      expect(asUser.status).toBe(403);
      expect(asAdmin.status).toBe(200);
      expect(asAdmin.body.verifications).toHaveLength(1);
      expect(asAdmin.body.pagination).toEqual({ page: 1, limit: 20, total: 1, pages: 1 });
    });

    it('sert le document sans cache', async () => {
      const { admin, verificationId } = await pendingRequest();

      const res = await request(app)
        .get(`/api/verification/admin/document/${verificationId}`)
        .set('Authorization', auth(admin));

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.headers['cache-control']).toBe('no-store, private');
    });

    it('approuve une demande une seule fois', async () => {
      const { user, admin, verificationId } = await pendingRequest();
      const approve = () =>
        request(app).post(`/api/verification/admin/approve/${verificationId}`).set('Authorization', auth(admin));

      const first = await approve();
      const second = await approve();

      expect(first.status).toBe(200);
      expect((await User.findById(user._id))?.isIdentityVerified).toBe(true);
      expect(second.status).toBe(400);
      expect(second.body.code).toBe('VERIFICATION_ALREADY_PROCESSED');
    });

    it('exige un motif pour rejeter une demande', async () => {
      const { admin, verificationId } = await pendingRequest();
      const reject = (body: object) =>
        request(app).post(`/api/verification/admin/reject/${verificationId}`).set('Authorization', auth(admin)).send(body);

      const withoutReason = await reject({});
      const withReason = await reject({ reason: 'Document illisible' });

      expect(withoutReason.status).toBe(400);
      expect(withReason.status).toBe(200);
    });

    it('répond 404 pour une demande inexistante', async () => {
      const { admin } = await pendingRequest();

      const res = await request(app)
        .post('/api/verification/admin/approve/507f1f77bcf86cd799439011')
        .set('Authorization', auth(admin));

      expect(res.status).toBe(404);
    });
  });
});
