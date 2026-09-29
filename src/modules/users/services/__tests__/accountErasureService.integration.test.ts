jest.mock('../../../../commons/services/secureStorageService', () => ({
  deleteSecureDocument: jest.fn()
}));

import {
  startInMemoryMongo,
  stopInMemoryMongo,
  clearAllCollections
} from '../../../../tests/helpers/mongoMemory';
import { createTestProduct, createTestUser } from '../../../../tests/helpers/fixtures';
import User from '../../../../models/userModel';
import Product from '../../../../models/productModel';
import SearchHistory from '../../../../models/historicSearchModel';
import RefreshToken from '../../../../models/tokenModel';
import IdentityVerification from '../../../../models/identityVerificationModel';
import Follow from '../../../follows/model';
import { deleteSecureDocument } from '../../../../commons/services/secureStorageService';
import { eraseAccountsDueForDeletion, eraseUserAccount } from '../accountErasureService';

async function createUserWithPersonalData() {
  const user = await createTestUser({
    firstName: 'Camille',
    lastName: 'Durand',
    phoneNumber: '+33612345678',
    isPhoneVerified: true,
    bio: 'Fan de BTS à Lyon'
  });
  const other = await createTestUser();
  await Promise.all([
    SearchHistory.create({ userId: user._id, query: 'bts', resultCount: 3 }),
    RefreshToken.create({ userId: user._id, token: 'refresh-abc', expiresAt: new Date(Date.now() + 3600e3) }),
    IdentityVerification.create({
      user: user._id,
      documentType: 'id_card',
      documentReferenceId: 'doc-ref',
      expiresAt: new Date(Date.now() + 3600e3)
    }),
    Follow.create({ follower: user._id, following: other._id }),
    createTestProduct(user._id)
  ]);
  return user;
}

describe('accountErasureService (integration)', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 60000);

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  beforeEach(async () => {
    await clearAllCollections();
    (deleteSecureDocument as jest.Mock).mockClear();
  });

  it('efface les données personnelles et désactive le compte', async () => {
    const user = await createUserWithPersonalData();
    const originalEmail = user.email;

    const { pseudonym } = await eraseUserAccount(user._id.toString());

    const erased = (await User.findById(user._id).lean())!;
    expect(erased.username).toBe(pseudonym);
    expect(erased.email).not.toContain(originalEmail);
    expect(erased.firstName).toBeUndefined();
    expect(erased.lastName).toBeUndefined();
    expect(erased.phoneNumber).toBeUndefined();
    expect(erased.bio).toBe('');
    expect(erased.accountStatus).toBe('deleted');
    expect(erased.anonymized).toBe(true);
  });

  it('supprime les données annexes et retire les annonces en vente', async () => {
    const user = await createUserWithPersonalData();

    await eraseUserAccount(user._id.toString());

    expect(await SearchHistory.countDocuments({ userId: user._id })).toBe(0);
    expect(await RefreshToken.countDocuments({ userId: user._id })).toBe(0);
    expect(await IdentityVerification.countDocuments({ user: user._id })).toBe(0);
    expect(await Follow.countDocuments({ follower: user._id })).toBe(0);
    expect(deleteSecureDocument).toHaveBeenCalledWith('doc-ref');
    expect(await Product.countDocuments({ seller: user._id, isAvailable: true })).toBe(0);
  });

  it('libère l\'email et le pseudo : la personne peut recréer un compte', async () => {
    const user = await createUserWithPersonalData();
    const { email, username } = user;

    await eraseUserAccount(user._id.toString());

    await expect(createTestUser({ email, username })).resolves.toBeTruthy();
  });

  it('exécute seulement les suppressions arrivées à échéance', async () => {
    const due = await createTestUser({ scheduledForDeletion: true, scheduledDeletionDate: new Date(Date.now() - 1000) });
    const later = await createTestUser({ scheduledForDeletion: true, scheduledDeletionDate: new Date(Date.now() + 86400e3) });

    const count = await eraseAccountsDueForDeletion();

    expect(count).toBe(1);
    expect((await User.findById(due._id))?.accountStatus).toBe('deleted');
    expect((await User.findById(later._id))?.accountStatus).not.toBe('deleted');
  });
});
