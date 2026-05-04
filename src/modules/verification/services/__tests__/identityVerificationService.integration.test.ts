jest.mock('../../../../commons/services/secureStorageService', () => ({
  secureStoreDocument: jest.fn().mockResolvedValue('test-ref-id'),
  deleteSecureDocument: jest.fn()
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
  cancelUserVerification
} from '../identityVerificationService';
import { secureStoreDocument, deleteSecureDocument } from '../../../../commons/services/secureStorageService';
import { sendVerificationResultEmail } from '../../../../commons/services/emailService';
import IdentityVerification from '../../../../models/identityVerificationModel';
import User from '../../../../models/userModel';

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
        fileBuffer: Buffer.from('fake-doc'),
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

    it('400 si consentGiven est false', async () => {
      const user = await createTestUser();
      await expect(
        submitIdentityVerification({
          userId: user._id.toString(),
          documentType: 'id_card',
          consentGiven: false,
          fileBuffer: Buffer.from('x'),
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
        fileBuffer: Buffer.from('x'),
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
          fileBuffer: Buffer.from('x'),
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
        fileBuffer: Buffer.from('x'),
        mimetype: 'image/jpeg'
      });

      await expect(
        submitIdentityVerification({
          userId: user._id.toString(),
          documentType: 'passport',
          consentGiven: true,
          fileBuffer: Buffer.from('y'),
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
        fileBuffer: Buffer.from('x'),
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

    it('400 si déjà traité', async () => {
      const admin = await createTestUser({ role: 'admin' });
      const user = await createTestUser();

      const submitted = await submitIdentityVerification({
        userId: user._id.toString(),
        documentType: 'id_card',
        consentGiven: true,
        fileBuffer: Buffer.from('x'),
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
        fileBuffer: Buffer.from('x'),
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
        fileBuffer: Buffer.from('x'),
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
        fileBuffer: Buffer.from('x'),
        mimetype: 'image/jpeg'
      });
      await submitIdentityVerification({
        userId: user2._id.toString(),
        documentType: 'passport',
        consentGiven: true,
        fileBuffer: Buffer.from('y'),
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
        fileBuffer: Buffer.from('x'),
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
        fileBuffer: Buffer.from('x'),
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
});
