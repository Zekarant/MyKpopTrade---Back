import {
  startInMemoryMongo,
  stopInMemoryMongo,
  clearAllCollections
} from '../../../../tests/helpers/mongoMemory';
import { createTestUser } from '../../../../tests/helpers/fixtures';
import { checkSessionPassword } from '../passwordService';
import User from '../../../../models/userModel';

describe('checkSessionPassword (integration)', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 60000);

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  beforeEach(async () => {
    await clearAllCollections();
  });

  const withPassword = async (userId: unknown) => (await User.findById(userId).select('+password'))!;

  it('accepte le bon mot de passe, sans limite de réussites', async () => {
    const user = await withPassword((await createTestUser())._id);

    for (let i = 0; i < 6; i++) {
      expect(await checkSessionPassword(user, 'Password1!')).toBe(true);
    }
  });

  it('bloque (429) après 5 échecs, même avec le bon mot de passe', async () => {
    const user = await withPassword((await createTestUser())._id);
    for (let i = 0; i < 5; i++) {
      expect(await checkSessionPassword(user, 'Mauvais1!')).toBe(false);
    }

    await expect(checkSessionPassword(user, 'Password1!'))
      .rejects.toMatchObject({ statusCode: 429, code: 'TOO_MANY_PASSWORD_ATTEMPTS' });
  });

  it('ne laisse pas passer plus de 5 essais envoyés en parallèle', async () => {
    const user = await withPassword((await createTestUser())._id);

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => checkSessionPassword(user, 'Mauvais1!'))
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(5);
  });

  it('compte les échecs par utilisateur', async () => {
    const [attacked, other] = [await createTestUser(), await createTestUser()];
    const target = await withPassword(attacked._id);
    for (let i = 0; i < 5; i++) await checkSessionPassword(target, 'Mauvais1!');

    expect(await checkSessionPassword(await withPassword(other._id), 'Password1!')).toBe(true);
  });

  it('refuse sans lever un compte qui n\'a pas de mot de passe (OAuth)', async () => {
    const created = await createTestUser();
    await User.collection.updateOne({ _id: created._id }, { $unset: { password: '' } });

    expect(await checkSessionPassword(await withPassword(created._id), 'Password1!')).toBe(false);
  });
});
