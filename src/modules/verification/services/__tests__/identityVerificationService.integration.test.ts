jest.mock('../../../../commons/services/secureStorageService', () => ({
  secureStoreDocument: jest.fn().mockResolvedValue('test-ref-id'),
  deleteSecureDocument: jest.fn(),
  retrieveSecureDocument: jest.fn().mockReturnValue({
    buffer: Buffer.from('doc'),
    metadata: { type: 'image/png' }
  }),
  cleanExpiredDocuments: jest.fn()
}));

jest.mock('../../../../commons/services/emailService', () => ({
  sendVerificationResultEmail: jest.fn().mockResolvedValue(undefined)
}));

import {
  startInMemoryMongo,
  stopInMemoryMongo,
  clearAllCollections
} from '../../../../tests/helpers/mongoMemory';
import { createTestUser } from '../../../../tests/helpers/fixtures';
import {
  submitIdentityVerification,
  fetchVerificationStatus,
  approveIdentityVerification,
  rejectIdentityVerification,
  listPendingVerifications,
  cancelUserVerification,
  expireStaleVerifications,
  getVerificationDocumentForAdmin
} from '../identityVerificationService';
import AuditLog from '../../../../models/auditLogModel';
import { secureStoreDocument, deleteSecureDocument } from '../../../../commons/services/secureStorageService';
import { sendVerificationResultEmail } from '../../../../commons/services/emailService';
import IdentityVerification from '../../../../models/identityVerificationModel';
import User from '../../../../models/userModel';

/** En-tête JPEG valide : le service contrôle désormais le vrai type du fichier. */
const jpegBuffer = (payload = 'x') => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(payload)]);

describe('identityVerificationService (integration)', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 60000);

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  beforeEach(async () => {
    await clearAllCollections();
    (secureStoreDocument as jest.Mock).mockClear();
    (deleteSecureDocument as jest.Mock).mockClear();
    (sendVerificationResultEmail as jest.Mock).mockClear();
  });

  describe('submitIdentityVerification', () => {
    it('crée une demande pending avec document stocké', async () => {
      const user = await createTestUser();

      const result = await submitIdentityVerification({
        userId: user._id.toString(),
        documentType: 'id_card',
        consentGiven: true,
        fileBuffer: jpegBuffer('fake-doc'),
        mimetype: 'image/jpeg'
      });

      expect(result.status).toBe('pending');
      expect(result.documentType).toBe('id_card');
      expect(secureStoreDocument).toHaveBeenCalledWith(
        expect.any(Buffer),
        'image/jpeg',
        'id_card'
      );

      const saved = await IdentityVerification.findById(result.id);
      expect(saved?.user.toString()).toBe(user._id.toString());
      expect(saved?.status).toBe('pending');
    });

    it('400 si fichier manquant', async () => {
      const user = await createTestUser();
      await expect(
        submitIdentityVerification({
          userId: user._id.toString(),
          documentType: 'id_card',
          consentGiven: true,
          fileBuffer: undefined,
          mimetype: undefined
        })
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('400 si le fichier n\'est pas une vraie image, même déclaré image/jpeg', async () => {
      const user = await createTestUser();
      await expect(
        submitIdentityVerification({
          userId: user._id.toString(),
          documentType: 'id_card',
          consentGiven: true,
          fileBuffer: Buffer.from('%PDF-1.7 pas une image'),
          mimetype: 'image/jpeg'
        })
      ).rejects.toMatchObject({ statusCode: 400 });
      expect(secureStoreDocument).not.toHaveBeenCalled();
    });

    it('400 si consentGiven est false', async () => {
      const user = await createTestUser();
      await expect(
        submitIdentityVerification({
          userId: user._id.toString(),
          documentType: 'id_card',
          consentGiven: false,
          fileBuffer: jpegBuffer(),
          mimetype: 'image/jpeg'
        })
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('accepte consentGiven="true" (string form-data)', async () => {
      const user = await createTestUser();
      const result = await submitIdentityVerification({
        userId: user._id.toString(),
        documentType: 'passport',
        consentGiven: 'true',
        fileBuffer: jpegBuffer(),
        mimetype: 'image/jpeg'
      });
      expect(result.status).toBe('pending');
    });

    it('400 pour un type de document invalide', async () => {
      const user = await createTestUser();
      await expect(
        submitIdentityVerification({
          userId: user._id.toString(),
          documentType: 'fake_doc',
          consentGiven: true,
          fileBuffer: jpegBuffer(),
          mimetype: 'image/jpeg'
        })
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('409 si une demande pending existe déjà', async () => {
      const user = await createTestUser();

      await submitIdentityVerification({
        userId: user._id.toString(),
        documentType: 'id_card',
        consentGiven: true,
        fileBuffer: jpegBuffer(),
        mimetype: 'image/jpeg'
      });

      await expect(
        submitIdentityVerification({
          userId: user._id.toString(),
          documentType: 'passport',
          consentGiven: true,
          fileBuffer: jpegBuffer('y'),
          mimetype: 'image/jpeg'
        })
      ).rejects.toMatchObject({ statusCode: 409 });
    });
  });

  describe('approveIdentityVerification', () => {
    it('approuve la demande, met à jour User, supprime le doc, envoie email', async () => {
      const admin = await createTestUser({ role: 'admin' });
      const user = await createTestUser();

      const submitted = await submitIdentityVerification({
        userId: user._id.toString(),
        documentType: 'id_card',
        consentGiven: true,
        fileBuffer: jpegBuffer(),
        mimetype: 'image/jpeg'
      });

      await approveIdentityVerification({
        verificationId: submitted.id.toString(),
        adminId: admin._id.toString()
      });

      const v = await IdentityVerification.findById(submitted.id);
      expect(v?.status).toBe('approved');
      expect(v?.processedBy?.toString()).toBe(admin._id.toString());

      const refreshedUser = await User.findById(user._id);
      expect(refreshedUser?.isIdentityVerified).toBe(true);
      expect(refreshedUser?.verificationLevel).toBe('complete');

      expect(deleteSecureDocument).toHaveBeenCalledWith('test-ref-id');
      expect(sendVerificationResultEmail).toHaveBeenCalledWith(user.email, true);
    });

    it('supprime le document et valide même si l\'email de résultat échoue', async () => {
      const admin = await createTestUser({ role: 'admin' });
      const user = await createTestUser();
      const submitted = await submitIdentityVerification({
        userId: user._id.toString(),
        documentType: 'id_card',
        consentGiven: true,
        fileBuffer: jpegBuffer(),
        mimetype: 'image/jpeg'
      });
      (sendVerificationResultEmail as jest.Mock).mockRejectedValueOnce(new Error('SMTP down'));

      await approveIdentityVerification({
        verificationId: submitted.id.toString(),
        adminId: admin._id.toString()
      });

      expect(deleteSecureDocument).toHaveBeenCalledWith('test-ref-id');
      expect((await User.findById(user._id))?.isIdentityVerified).toBe(true);
    });

    it('400 si déjà traité', async () => {
      const admin = await createTestUser({ role: 'admin' });
      const user = await createTestUser();

      const submitted = await submitIdentityVerification({
        userId: user._id.toString(),
        documentType: 'id_card',
        consentGiven: true,
        fileBuffer: jpegBuffer(),
        mimetype: 'image/jpeg'
      });

      await approveIdentityVerification({
        verificationId: submitted.id.toString(),
        adminId: admin._id.toString()
      });

      await expect(
        approveIdentityVerification({
          verificationId: submitted.id.toString(),
          adminId: admin._id.toString()
        })
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('400 si l\'ID est invalide', async () => {
      const admin = await createTestUser({ role: 'admin' });
      await expect(
        approveIdentityVerification({
          verificationId: 'not-an-id',
          adminId: admin._id.toString()
        })
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('404 si la vérification n\'existe pas', async () => {
      const admin = await createTestUser({ role: 'admin' });
      await expect(
        approveIdentityVerification({
          verificationId: '507f1f77bcf86cd799439011',
          adminId: admin._id.toString()
        })
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('rejectIdentityVerification', () => {
    it('rejette avec une raison, envoie email + supprime doc', async () => {
      const admin = await createTestUser({ role: 'admin' });
      const user = await createTestUser();

      const submitted = await submitIdentityVerification({
        userId: user._id.toString(),
        documentType: 'id_card',
        consentGiven: true,
        fileBuffer: jpegBuffer(),
        mimetype: 'image/jpeg'
      });

      await rejectIdentityVerification({
        verificationId: submitted.id.toString(),
        adminId: admin._id.toString(),
        reason: 'Document flou'
      });

      const v = await IdentityVerification.findById(submitted.id);
      expect(v?.status).toBe('rejected');
      expect(v?.rejectionReason).toBe('Document flou');

      expect(deleteSecureDocument).toHaveBeenCalled();
      expect(sendVerificationResultEmail).toHaveBeenCalledWith(user.email, false, 'Document flou');
    });

    it('400 sans raison', async () => {
      const admin = await createTestUser({ role: 'admin' });
      const user = await createTestUser();

      const submitted = await submitIdentityVerification({
        userId: user._id.toString(),
        documentType: 'id_card',
        consentGiven: true,
        fileBuffer: jpegBuffer(),
        mimetype: 'image/jpeg'
      });

      await expect(
        rejectIdentityVerification({
          verificationId: submitted.id.toString(),
          adminId: admin._id.toString(),
          reason: ''
        })
      ).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  describe('listPendingVerifications', () => {
    it('retourne les demandes pending paginées (admin uniquement)', async () => {
      const admin = await createTestUser({ role: 'admin' });
      const user1 = await createTestUser();
      const user2 = await createTestUser();

      await submitIdentityVerification({
        userId: user1._id.toString(),
        documentType: 'id_card',
        consentGiven: true,
        fileBuffer: jpegBuffer(),
        mimetype: 'image/jpeg'
      });
      await submitIdentityVerification({
        userId: user2._id.toString(),
        documentType: 'passport',
        consentGiven: true,
        fileBuffer: jpegBuffer('y'),
        mimetype: 'image/jpeg'
      });

      const result = await listPendingVerifications(admin._id.toString(), 1, 10);

      expect(result.verifications.length).toBe(2);
      expect(result.pagination.total).toBe(2);
    });

    it('403 pour un non-admin', async () => {
      const user = await createTestUser();
      await expect(
        listPendingVerifications(user._id.toString(), 1, 10)
      ).rejects.toMatchObject({ statusCode: 403 });
    });
  });

  describe('cancelUserVerification', () => {
    it('supprime la demande pending + document', async () => {
      const user = await createTestUser();

      const submitted = await submitIdentityVerification({
        userId: user._id.toString(),
        documentType: 'id_card',
        consentGiven: true,
        fileBuffer: jpegBuffer(),
        mimetype: 'image/jpeg'
      });

      await cancelUserVerification(user._id.toString());

      const v = await IdentityVerification.findById(submitted.id);
      expect(v).toBeNull();
      expect(deleteSecureDocument).toHaveBeenCalled();
    });

    it('404 si aucune demande pending', async () => {
      const user = await createTestUser();
      await expect(
        cancelUserVerification(user._id.toString())
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('fetchVerificationStatus', () => {
    it('retourne la dernière demande + niveau utilisateur', async () => {
      const user = await createTestUser();

      const submitted = await submitIdentityVerification({
        userId: user._id.toString(),
        documentType: 'id_card',
        consentGiven: true,
        fileBuffer: jpegBuffer(),
        mimetype: 'image/jpeg'
      });

      const status = await fetchVerificationStatus(user._id.toString());

      expect(status.verification.id.toString()).toBe(submitted.id.toString());
      expect(status.verification.status).toBe('pending');
      expect(status.userVerification.isVerified).toBe(false);
      expect(status.userVerification.level).toBe('none');
    });

    it('404 si aucune demande existante', async () => {
      const user = await createTestUser();
      await expect(
        fetchVerificationStatus(user._id.toString())
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('expireStaleVerifications', () => {
    it('clôt les demandes échues, supprime leur document et garde les autres', async () => {
      const staleUser = await createTestUser();
      const freshUser = await createTestUser();
      const stale = await submitIdentityVerification({
        userId: staleUser._id.toString(),
        documentType: 'id_card',
        consentGiven: true,
        fileBuffer: jpegBuffer(),
        mimetype: 'image/jpeg'
      });
      const fresh = await submitIdentityVerification({
        userId: freshUser._id.toString(),
        documentType: 'passport',
        consentGiven: true,
        fileBuffer: jpegBuffer('y'),
        mimetype: 'image/jpeg'
      });
      await IdentityVerification.updateOne({ _id: stale.id }, { expiresAt: new Date(Date.now() - 1000) });

      const count = await expireStaleVerifications();

      expect(count).toBe(1);
      expect((await IdentityVerification.findById(stale.id))?.status).toBe('rejected');
      expect((await IdentityVerification.findById(fresh.id))?.status).toBe('pending');
      expect(deleteSecureDocument).toHaveBeenCalledTimes(1);
    });
  });

  describe('getVerificationDocumentForAdmin', () => {
    it('renvoie le document et trace la consultation', async () => {
      const admin = await createTestUser({ role: 'admin' });
      const user = await createTestUser();
      const submitted = await submitIdentityVerification({
        userId: user._id.toString(),
        documentType: 'id_card',
        consentGiven: true,
        fileBuffer: jpegBuffer(),
        mimetype: 'image/jpeg'
      });

      const doc = await getVerificationDocumentForAdmin(submitted.id.toString(), admin._id.toString());

      expect(doc.contentType).toBe('image/png');
      expect(doc.buffer.toString()).toBe('doc');
      expect(await AuditLog.countDocuments({ action: 'verification_document_viewed' })).toBe(1);
    });
  });
});
