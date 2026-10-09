import passport from 'passport';
import type { Request } from 'express';
import { startInMemoryMongo, stopInMemoryMongo, clearAllCollections } from '../../tests/helpers/mongoMemory';
import { createTestUser } from '../../tests/helpers/fixtures';
import User from '../../models/userModel';
import RefreshToken from '../../models/tokenModel';
import { generateRefreshToken } from '../../commons/services/tokenService';
import { initializePassport } from '../passport';
import env from '../env';

// Identifiants factices : la stratégie est enregistrée sans aucun appel réseau.
env.GOOGLE_CLIENT_ID = 'client-de-test';
env.GOOGLE_CLIENT_SECRET = 'secret-de-test';

type VerifyDone = (error: Error | null, user?: unknown, info?: { message?: string }) => void;
type GoogleVerify = (req: Request, accessToken: string, refreshToken: string, profile: object, done: VerifyDone) => void;

/** Rejoue le retour de Google : seul le callback de vérification nous intéresse. */
function signInWithGoogle(email: string): Promise<void> {
  const strategy = (passport as unknown as { _strategy(name: string): { _verify: GoogleVerify } })._strategy('google');
  const profile = {
    id: 'google-victime',
    displayName: 'Mina Kim',
    name: { givenName: 'Mina', familyName: 'Kim' },
    emails: [{ value: email }],
    photos: [],
    _json: { email_verified: true }
  };
  return new Promise((resolve, reject) => {
    strategy._verify({} as Request, 'access', 'refresh', profile, (error) => (error ? reject(error) : resolve()));
  });
}

describe('passport — rattachement OAuth à un compte existant', () => {
  beforeAll(async () => {
    initializePassport();
    await startInMemoryMongo();
  }, 60000);

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  beforeEach(async () => {
    await clearAllCollections();
  });

  it('retire au créateur d\'un compte non vérifié le mot de passe, la 2FA et les sessions', async () => {
    // Un tiers s'inscrit avec l'adresse de la victime, sans pouvoir la vérifier.
    const squatter = await createTestUser({ email: 'victime@test.com', password: 'Squatteur1!', isEmailVerified: false });
    await User.updateOne({ _id: squatter._id }, { $set: { 'twoFactor.enabled': true } });
    await generateRefreshToken(squatter._id.toString());

    await signInWithGoogle('victime@test.com');

    const claimed = await User.findById(squatter._id).select('+password');
    expect(claimed!.isEmailVerified).toBe(true);
    expect(claimed!.socialAuth?.google?.id).toBe('google-victime');
    await expect(claimed!.comparePassword('Squatteur1!')).resolves.toBe(false);
    expect(claimed!.twoFactor?.enabled).toBe(false);
    await expect(RefreshToken.countDocuments({ userId: squatter._id })).resolves.toBe(0);
  });

  it('garde le mot de passe et les sessions d\'un compte déjà vérifié', async () => {
    const owner = await createTestUser({ email: 'mina@test.com', password: 'Proprio1!', isEmailVerified: true });
    await generateRefreshToken(owner._id.toString());

    await signInWithGoogle('mina@test.com');

    const linked = await User.findById(owner._id).select('+password');
    expect(linked!.socialAuth?.google?.id).toBe('google-victime');
    await expect(linked!.comparePassword('Proprio1!')).resolves.toBe(true);
    await expect(RefreshToken.countDocuments({ userId: owner._id })).resolves.toBe(1);
  });
});
