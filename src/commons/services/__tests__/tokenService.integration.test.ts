import crypto from 'crypto';
import {
  startInMemoryMongo,
  stopInMemoryMongo,
  clearAllCollections
} from '../../../tests/helpers/mongoMemory';
import { createTestUser } from '../../../tests/helpers/fixtures';
import RefreshToken from '../../../models/tokenModel';
import {
  generateRefreshToken,
  rotateRefreshToken,
  invalidateRefreshToken,
  invalidateOtherUserRefreshTokens
} from '../tokenService';

/** Refresh tokens : stockés hachés, à usage unique, détection d'un jeton volé. */
describe('tokenService — refresh tokens (integration)', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 60000);

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  beforeEach(async () => {
    await clearAllCollections();
  });

  const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

  async function newSession() {
    const user = await createTestUser();
    const token = await generateRefreshToken(user._id.toString());
    return { userId: user._id.toString(), token };
  }

  it('ne stocke que l\'empreinte du jeton', async () => {
    const { token } = await newSession();

    const stored = await RefreshToken.findOne({});
    expect(stored!.token).toBe(sha256(token));
    expect(stored!.token).not.toBe(token);
    expect(await rotateRefreshToken(stored!.token)).toBeNull();
  });

  it('échange le jeton contre un nouveau, en gardant l\'échéance de la session', async () => {
    const { userId, token } = await newSession();
    const original = await RefreshToken.findOne({});

    const rotated = await rotateRefreshToken(token);

    expect(rotated!.userId).toBe(userId);
    expect(rotated!.refreshToken).not.toBe(token);
    const renewed = await RefreshToken.findOne({ token: sha256(rotated!.refreshToken) });
    expect(renewed!.expiresAt.getTime()).toBe(original!.expiresAt.getTime());
  });

  it('accepte encore l\'ancien jeton pendant le délai de grâce (deux onglets)', async () => {
    const { token } = await newSession();
    const first = await rotateRefreshToken(token);

    const second = await rotateRefreshToken(token);

    expect(second).not.toBeNull();
    expect(await rotateRefreshToken(first!.refreshToken)).not.toBeNull();
  });

  it('ferme toutes les sessions si un jeton échangé resurgit après le délai de grâce', async () => {
    const { userId, token } = await newSession();
    const other = await generateRefreshToken(userId);
    const rotated = await rotateRefreshToken(token);
    await RefreshToken.updateOne({ token: sha256(token) }, { $set: { rotatedAt: new Date(Date.now() - 60_000) } });

    expect(await rotateRefreshToken(token)).toBeNull();

    expect(await RefreshToken.countDocuments({ userId })).toBe(0);
    expect(await rotateRefreshToken(rotated!.refreshToken)).toBeNull();
    expect(await rotateRefreshToken(other)).toBeNull();
  });

  it('refuse un jeton expiré', async () => {
    const { token } = await newSession();
    await RefreshToken.updateOne({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });

    expect(await rotateRefreshToken(token)).toBeNull();
  });

  it('accepte une fois le jeton en clair d\'une session ouverte avant le hachage', async () => {
    const user = await createTestUser();
    await RefreshToken.create({
      token: 'ancien-jeton-en-clair',
      userId: user._id,
      expiresAt: new Date(Date.now() + 3600e3)
    });

    const rotated = await rotateRefreshToken('ancien-jeton-en-clair');

    expect(rotated!.userId).toBe(user._id.toString());
    expect(await RefreshToken.exists({ token: 'ancien-jeton-en-clair' })).toBeNull();
    expect(await rotateRefreshToken('ancien-jeton-en-clair')).toBeNull();
  });

  it('invalide un jeton haché comme un ancien jeton en clair', async () => {
    const { token } = await newSession();
    const user = await createTestUser();
    await RefreshToken.create({ token: 'ancien', userId: user._id, expiresAt: new Date(Date.now() + 3600e3) });

    expect(await invalidateRefreshToken(token)).toBe(true);
    expect(await invalidateRefreshToken('ancien')).toBe(true);
    expect(await RefreshToken.countDocuments({})).toBe(0);
  });

  describe('invalidateOtherUserRefreshTokens', () => {
    it('ferme les autres sessions de l\'utilisateur et garde la session courante', async () => {
      const { userId, token } = await newSession();
      const otherDevice = await generateRefreshToken(userId);
      const stranger = await newSession();

      expect(await invalidateOtherUserRefreshTokens(userId, token)).toBe(1);

      expect(await rotateRefreshToken(otherDevice)).toBeNull();
      expect(await rotateRefreshToken(token)).not.toBeNull();
      expect(await rotateRefreshToken(stranger.token)).not.toBeNull();
    });

    it('garde une session ouverte avant le hachage quand c\'est la session courante', async () => {
      const user = await createTestUser();
      await RefreshToken.create({ token: 'ancien', userId: user._id, expiresAt: new Date(Date.now() + 3600e3) });
      await generateRefreshToken(user._id.toString());

      await invalidateOtherUserRefreshTokens(user._id.toString(), 'ancien');

      expect(await RefreshToken.countDocuments({ userId: user._id })).toBe(1);
      expect(await RefreshToken.exists({ token: 'ancien' })).not.toBeNull();
    });

    it('ferme toutes les sessions quand aucune session courante n\'est connue', async () => {
      const { userId } = await newSession();
      await generateRefreshToken(userId);

      expect(await invalidateOtherUserRefreshTokens(userId)).toBe(2);
    });
  });
});
