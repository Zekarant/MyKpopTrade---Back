// Le changement d'email déclenche sendVerificationEmail, qui construit un
// transporteur nodemailer — en test cela appelait réellement ethereal.email et
// rendait cette suite instable (timeouts intermittents). Même mock que les
// autres suites d'intégration.
jest.mock('../../../../commons/services/emailService', () => ({
  sendVerificationEmail: jest.fn().mockResolvedValue(undefined)
}));

import {
  startInMemoryMongo,
  stopInMemoryMongo,
  clearAllCollections
} from '../../../../tests/helpers/mongoMemory';
import { createTestUser } from '../../../../tests/helpers/fixtures';
import {
  getPublicProfileData,
  updateProfileData,
  softDeleteAccount,
  setPayPalEmail,
  clearPayPalEmail
} from '../authProfileService';
import User from '../../../../models/userModel';

describe('authProfileService (integration)', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 60000);

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  beforeEach(async () => {
    await clearAllCollections();
  });

  describe('getPublicProfileData', () => {
    it('retourne l\'utilisateur sans champs sensibles', async () => {
      const user = await createTestUser();
      const result = await getPublicProfileData(user._id.toString());
      expect(result.password).toBeUndefined();
      expect((result as any).emailVerificationToken).toBeUndefined();
    });

    it('404 si utilisateur inexistant', async () => {
      await expect(
        getPublicProfileData('507f1f77bcf86cd799439011')
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('updateProfileData', () => {
    it('met à jour les champs simples (bio, location)', async () => {
      const user = await createTestUser({ bio: 'old' });
      const result = await updateProfileData(user._id.toString(), {
        bio: 'new bio',
        location: 'Paris'
      });

      expect(result.user.bio).toBe('new bio');
      expect(result.user.location).toBe('Paris');
      expect(result.message).toBe('Profil mis à jour avec succès');
    });

    it('tronque bio > 500 caractères', async () => {
      const user = await createTestUser();
      const longBio = 'a'.repeat(600);
      const result = await updateProfileData(user._id.toString(), {
        bio: longBio
      });

      expect(result.user.bio?.length).toBe(500);
    });

    it('change username + vérifie l\'unicité', async () => {
      const user = await createTestUser();
      const result = await updateProfileData(user._id.toString(), {
        username: 'new_username'
      });
      expect(result.user.username).toBe('new_username');
    });

    it('400 si username invalide', async () => {
      const user = await createTestUser();
      await expect(
        updateProfileData(user._id.toString(), { username: 'ab' })
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('400 si username déjà pris par un autre user', async () => {
      await createTestUser({ username: 'taken_name' });
      const user = await createTestUser();
      await expect(
        updateProfileData(user._id.toString(), { username: 'taken_name' })
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('change email, marque isEmailVerified=false et message verif', async () => {
      const user = await createTestUser({ isEmailVerified: true });
      const result = await updateProfileData(user._id.toString(), {
        email: 'new_email_unique@test.com'
      });

      expect(result.user.email).toBe('new_email_unique@test.com');
      expect(result.user.isEmailVerified).toBe(false);
      expect(result.message).toContain('vérifier');
    });

    it('400 si email invalide', async () => {
      const user = await createTestUser();
      await expect(
        updateProfileData(user._id.toString(), { email: 'pas-un-email' })
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('400 si email déjà pris', async () => {
      await createTestUser({ email: 'taken_email@test.com' });
      const user = await createTestUser();
      await expect(
        updateProfileData(user._id.toString(), { email: 'taken_email@test.com' })
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('change phoneNumber et reset isPhoneVerified', async () => {
      const user = await createTestUser();
      const result = await updateProfileData(user._id.toString(), {
        phoneNumber: '+33612345678'
      });
      expect(result.user.phoneNumber).toBe('+33612345678');
      expect(result.user.isPhoneVerified).toBe(false);
      expect(result.message).toContain('numéro de téléphone');
    });

    it('efface le phoneNumber avec chaîne vide', async () => {
      const user = await createTestUser({ phoneNumber: '+33612345678', isPhoneVerified: true });
      const result = await updateProfileData(user._id.toString(), {
        phoneNumber: ''
      });
      expect(result.user.phoneNumber).toBeUndefined();
      expect(result.user.isPhoneVerified).toBe(false);
    });

    it('400 si phoneNumber format invalide', async () => {
      const user = await createTestUser();
      await expect(
        updateProfileData(user._id.toString(), { phoneNumber: 'abc123' })
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('change paypalEmail avec validation + unicité', async () => {
      const user = await createTestUser();
      const result = await updateProfileData(user._id.toString(), {
        paypalEmail: 'paypal@test.com'
      });
      expect(result.user.paypalEmail).toBe('paypal@test.com');
    });

    it('400 si paypalEmail = email principal', async () => {
      const user = await createTestUser();
      await expect(
        updateProfileData(user._id.toString(), { paypalEmail: user.email })
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('efface paypalEmail avec chaîne vide', async () => {
      const user = await createTestUser({ paypalEmail: 'paypal@test.com' });
      const result = await updateProfileData(user._id.toString(), {
        paypalEmail: ''
      });
      expect(result.user.paypalEmail).toBeUndefined();
    });

    it('combine email + phone changes dans le message', async () => {
      const user = await createTestUser();
      const result = await updateProfileData(user._id.toString(), {
        email: 'combo_email@test.com',
        phoneNumber: '+33711223344'
      });
      expect(result.message).toContain('email');
      expect(result.message).toContain('téléphone');
    });
  });

  describe('softDeleteAccount', () => {
    it('marque le compte deleted + préfixe email/username', async () => {
      const user = await createTestUser();
      const originalEmail = user.email;
      const originalUsername = user.username;

      await softDeleteAccount(user._id.toString(), 'Password1!');

      const refreshed = await User.findById(user._id);
      expect(refreshed?.accountStatus).toBe('deleted');
      expect(refreshed?.email).toContain(originalEmail);
      expect(refreshed?.email).toContain('deleted_');
      expect(refreshed?.username).toContain(originalUsername);
    });

    it('401 si mot de passe incorrect', async () => {
      const user = await createTestUser();
      await expect(
        softDeleteAccount(user._id.toString(), 'wrong_password')
      ).rejects.toMatchObject({ statusCode: 401 });
    });

    it('400 si mot de passe manquant (user non-social)', async () => {
      const user = await createTestUser();
      await expect(
        softDeleteAccount(user._id.toString(), undefined)
      ).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  describe('setPayPalEmail', () => {
    it('met à jour l\'email PayPal', async () => {
      const user = await createTestUser();
      const result = await setPayPalEmail(user._id.toString(), 'paypal@test.com');
      expect(result).toBe('paypal@test.com');
    });

    it('400 si paypalEmail = email principal', async () => {
      const user = await createTestUser();
      await expect(
        setPayPalEmail(user._id.toString(), user.email)
      ).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  describe('clearPayPalEmail', () => {
    it('supprime l\'email PayPal existant', async () => {
      const user = await createTestUser({ paypalEmail: 'paypal@test.com' });
      await clearPayPalEmail(user._id.toString());
      const refreshed = await User.findById(user._id);
      expect(refreshed?.paypalEmail).toBeUndefined();
    });

    it('400 si aucun paypalEmail à supprimer', async () => {
      const user = await createTestUser();
      await expect(
        clearPayPalEmail(user._id.toString())
      ).rejects.toMatchObject({ statusCode: 400 });
    });
  });
});
