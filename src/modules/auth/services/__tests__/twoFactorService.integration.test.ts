import { generateTotpCode, generateTotpSecret } from '../../../../commons/utils/totp';
import {
  startInMemoryMongo,
  stopInMemoryMongo,
  clearAllCollections
} from '../../../../tests/helpers/mongoMemory';
import { createTestUser } from '../../../../tests/helpers/fixtures';
import User from '../../../../models/userModel';
import { HttpError } from '../../../../commons/utils/httpError';
import {
  startTwoFactorActivation,
  confirmTwoFactorActivation,
  verifyTwoFactorCode,
  disableTwoFactor,
  regenerateRecoveryCodes,
  getTwoFactorStatus,
  isTwoFactorEnabled
} from '../twoFactorService';

/**
 * Tests de la double authentification TOTP.
 *
 * Les propriétés vérifiées sont celles dont dépend la sécurité du second
 * facteur : activation en deux temps, anti-rejeu, usage unique des codes de
 * secours, secret chiffré au repos, et impossibilité de désactiver sans le mot
 * de passe.
 */
describe('twoFactorService (integration)', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 60000);

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  beforeEach(async () => {
    await clearAllCollections();
  });

  const PASSWORD = 'Password1!';

  /** Active la 2FA sur un utilisateur neuf et rend ses éléments. */
  async function enableTwoFactorFor(userId: string) {
    const { secret } = await startTwoFactorActivation(userId);
    const { recoveryCodes } = await confirmTwoFactorActivation(userId, generateTotpCode(secret));
    return { secret, recoveryCodes };
  }

  describe('activation', () => {
    it('rend un QR code et un secret sans activer la 2FA', async () => {
      const user = await createTestUser();

      const result = await startTwoFactorActivation(user._id.toString());

      expect(result.qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);
      expect(result.secret).toMatch(/^[A-Z2-7]+$/);
      expect(result.otpauthUri).toContain('otpauth://totp/MyKpopTrade');

      const status = await getTwoFactorStatus(user._id.toString());
      expect(status.enabled).toBe(false);
      expect(status.activationPending).toBe(true);
    });

    it('refuse la confirmation avec un code invalide', async () => {
      const user = await createTestUser();
      await startTwoFactorActivation(user._id.toString());

      await expect(
        confirmTwoFactorActivation(user._id.toString(), '000000')
      ).rejects.toThrow(HttpError);

      const status = await getTwoFactorStatus(user._id.toString());
      expect(status.enabled).toBe(false);
    });

    it('refuse la confirmation sans activation en cours', async () => {
      const user = await createTestUser();

      await expect(
        confirmTwoFactorActivation(user._id.toString(), '123456')
      ).rejects.toThrow(HttpError);
    });

    it('active la 2FA et rend 8 codes de secours', async () => {
      const user = await createTestUser();

      const { recoveryCodes } = await enableTwoFactorFor(user._id.toString());

      expect(recoveryCodes).toHaveLength(8);
      recoveryCodes.forEach((code) => expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/));

      const status = await getTwoFactorStatus(user._id.toString());
      expect(status.enabled).toBe(true);
      expect(status.remainingRecoveryCodes).toBe(8);
      expect(status.enabledAt).toBeInstanceOf(Date);
    });

    it('refuse une seconde activation sur un compte déjà protégé', async () => {
      const user = await createTestUser();
      await enableTwoFactorFor(user._id.toString());

      await expect(startTwoFactorActivation(user._id.toString())).rejects.toThrow(HttpError);
    });
  });

  describe('stockage', () => {
    it('ne conserve jamais le secret en clair', async () => {
      const user = await createTestUser();
      const { secret } = await enableTwoFactorFor(user._id.toString());

      const stored = await User.findById(user._id).select('+twoFactor.secret');

      expect(stored!.twoFactor!.secret).toBeTruthy();
      expect(stored!.twoFactor!.secret).not.toContain(secret);
    });

    it('ne conserve jamais les codes de secours en clair', async () => {
      const user = await createTestUser();
      const { recoveryCodes } = await enableTwoFactorFor(user._id.toString());

      const stored = await User.findById(user._id).select('+twoFactor.recoveryCodes');
      const storedCodes = stored!.twoFactor!.recoveryCodes!;

      expect(storedCodes).toHaveLength(8);
      storedCodes.forEach((hash: string) => expect(hash).toMatch(/^[0-9a-f]{64}$/));
      recoveryCodes.forEach((clear) => expect(storedCodes).not.toContain(clear));
    });

    it('ne renvoie pas les champs 2FA sensibles sur une lecture normale', async () => {
      const user = await createTestUser();
      await enableTwoFactorFor(user._id.toString());

      const stored = await User.findById(user._id);

      expect(stored!.twoFactor!.enabled).toBe(true);
      expect(stored!.twoFactor!.secret).toBeUndefined();
      expect(stored!.twoFactor!.recoveryCodes).toBeUndefined();
    });
  });

  describe('vérification', () => {
    it('accepte un code TOTP courant', async () => {
      const user = await createTestUser();
      const { secret } = await enableTwoFactorFor(user._id.toString());

      // Le code de confirmation a consommé le pas de temps courant : on
      // repart d'un compteur vierge pour tester la vérification seule.
      await User.updateOne({ _id: user._id }, { $unset: { 'twoFactor.lastUsedTimeStep': 1 } });

      const result = await verifyTwoFactorCode(user._id.toString(), generateTotpCode(secret));

      expect(result.usedRecoveryCode).toBe(false);
    });

    it('refuse un code TOTP faux', async () => {
      const user = await createTestUser();
      await enableTwoFactorFor(user._id.toString());

      await expect(verifyTwoFactorCode(user._id.toString(), '000000')).rejects.toThrow(HttpError);
    });

    it('refuse le rejeu d\'un code déjà consommé', async () => {
      const user = await createTestUser();
      const { secret } = await enableTwoFactorFor(user._id.toString());
      await User.updateOne({ _id: user._id }, { $unset: { 'twoFactor.lastUsedTimeStep': 1 } });

      const code = generateTotpCode(secret);
      await verifyTwoFactorCode(user._id.toString(), code);

      // Même code, toujours dans sa fenêtre de validité de 30 s : doit être refusé.
      await expect(verifyTwoFactorCode(user._id.toString(), code)).rejects.toThrow(HttpError);
    });

    it('refuse un code issu du secret d\'un autre compte', async () => {
      const user = await createTestUser();
      await enableTwoFactorFor(user._id.toString());

      const foreignCode = generateTotpCode(generateTotpSecret());

      await expect(verifyTwoFactorCode(user._id.toString(), foreignCode)).rejects.toThrow(HttpError);
    });

    it('refuse la vérification si la 2FA n\'est pas activée', async () => {
      const user = await createTestUser();

      await expect(verifyTwoFactorCode(user._id.toString(), '123456')).rejects.toThrow(HttpError);
    });
  });

  describe('codes de secours', () => {
    it('accepte un code de secours et le consomme définitivement', async () => {
      const user = await createTestUser();
      const { recoveryCodes } = await enableTwoFactorFor(user._id.toString());
      const code = recoveryCodes[0];

      const first = await verifyTwoFactorCode(user._id.toString(), code);
      expect(first.usedRecoveryCode).toBe(true);
      expect(first.remainingRecoveryCodes).toBe(7);

      // Usage unique : le même code ne doit plus fonctionner.
      await expect(verifyTwoFactorCode(user._id.toString(), code)).rejects.toThrow(HttpError);
    });

    it('accepte un code de secours saisi en minuscules et avec des espaces', async () => {
      const user = await createTestUser();
      const { recoveryCodes } = await enableTwoFactorFor(user._id.toString());

      const result = await verifyTwoFactorCode(
        user._id.toString(),
        `  ${recoveryCodes[1].toLowerCase()}  `
      );

      expect(result.usedRecoveryCode).toBe(true);
    });

    it('invalide les anciens codes après régénération', async () => {
      const user = await createTestUser();
      const { recoveryCodes } = await enableTwoFactorFor(user._id.toString());
      const oldCode = recoveryCodes[0];

      const { recoveryCodes: newCodes } = await regenerateRecoveryCodes(
        user._id.toString(),
        recoveryCodes[7]
      );

      expect(newCodes).toHaveLength(8);
      expect(newCodes).not.toContain(oldCode);
      await expect(verifyTwoFactorCode(user._id.toString(), oldCode)).rejects.toThrow(HttpError);
    });
  });

  describe('désactivation', () => {
    it('exige le mot de passe', async () => {
      const user = await createTestUser({ password: PASSWORD });
      const { recoveryCodes } = await enableTwoFactorFor(user._id.toString());

      await expect(
        disableTwoFactor(user._id.toString(), 'MauvaisMotDePasse1!', recoveryCodes[0])
      ).rejects.toThrow(HttpError);

      const stillEnabled = await User.findById(user._id);
      expect(isTwoFactorEnabled(stillEnabled!)).toBe(true);
    });

    it('exige un code valide', async () => {
      const user = await createTestUser({ password: PASSWORD });
      await enableTwoFactorFor(user._id.toString());

      await expect(
        disableTwoFactor(user._id.toString(), PASSWORD, '000000')
      ).rejects.toThrow(HttpError);

      const stillEnabled = await User.findById(user._id);
      expect(isTwoFactorEnabled(stillEnabled!)).toBe(true);
    });

    it('désactive et efface tout le matériel 2FA', async () => {
      const user = await createTestUser({ password: PASSWORD });
      const { recoveryCodes } = await enableTwoFactorFor(user._id.toString());

      await disableTwoFactor(user._id.toString(), PASSWORD, recoveryCodes[0]);

      const stored = await User.findById(user._id).select(
        '+twoFactor.secret +twoFactor.recoveryCodes +twoFactor.lastUsedTimeStep'
      );

      expect(isTwoFactorEnabled(stored!)).toBe(false);
      expect(stored!.twoFactor!.secret).toBeUndefined();
      expect(stored!.twoFactor!.recoveryCodes).toBeUndefined();
      expect(stored!.twoFactor!.lastUsedTimeStep).toBeUndefined();
    });
  });
});
