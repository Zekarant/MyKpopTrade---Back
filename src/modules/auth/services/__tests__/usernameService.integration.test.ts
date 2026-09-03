import { generateUniqueUsername } from '../usernameService';
import User from '../../../../models/userModel';
import { validateUsername } from '../../../../commons/utils/validators';
import {
  startInMemoryMongo,
  stopInMemoryMongo,
  clearAllCollections
} from '../../../../tests/helpers/mongoMemory';

describe('generateUniqueUsername', () => {
  beforeAll(startInMemoryMongo);
  afterAll(stopInMemoryMongo);
  beforeEach(clearAllCollections);

  /** Crée un compte occupant `username`, pour forcer une collision. */
  async function occupy(username: string): Promise<void> {
    await User.create({
      username,
      email: `${username}@example.test`,
      password: 'motdepasse-long-assez'
    });
  }

  it('derives a readable username from the provider display name', async () => {
    const username = await generateUniqueUsername({ displayName: 'Marie Dupont' });
    expect(username).toBe('marie-dupont');
  });

  it('never produces the old user_<timestamp>_<hex> shape', async () => {
    const username = await generateUniqueUsername({ displayName: 'Marie Dupont' });
    expect(username).not.toMatch(/^user_\d+_[0-9a-f]+$/);
  });

  it('falls back to the given name when the display name is taken', async () => {
    await occupy('marie-dupont');

    const username = await generateUniqueUsername({
      displayName: 'Marie Dupont',
      givenName: 'Marie'
    });

    expect(username).toBe('marie');
  });

  it('numbers the preferred base once every candidate is taken', async () => {
    await occupy('marie-dupont');
    await occupy('marie');

    const username = await generateUniqueUsername({
      displayName: 'Marie Dupont',
      givenName: 'Marie'
    });

    expect(username).toBe('marie-dupont2');
  });

  it('uses the email local part when no name is provided', async () => {
    const username = await generateUniqueUsername({ email: 'marie.dupont@example.test' });
    expect(username).toBe('marie-dupont');
  });

  it('falls back to a padded default when nothing is usable', async () => {
    const username = await generateUniqueUsername({ displayName: '김민준' });
    expect(username).toBe('membre');
  });

  it('pads a base shorter than the minimum length', async () => {
    const username = await generateUniqueUsername({ displayName: 'Jo' });
    expect(username.length).toBeGreaterThanOrEqual(3);
    expect(username.startsWith('jo')).toBe(true);
  });

  it('always returns a value accepted by validateUsername', async () => {
    const inputs = [
      { displayName: 'Marie Dupont' },
      { displayName: 'Jo' },
      { displayName: '김민준' },
      { email: 'a@example.test' },
      { displayName: 'Marie Antoinette Josephe Jeanne de Habsbourg Lorraine' },
      {}
    ];

    for (const input of inputs) {
      const username = await generateUniqueUsername(input);
      expect(validateUsername(username)).toBe(true);
    }
  });

  it('resolves to a free username even after many collisions', async () => {
    await occupy('marie-dupont');
    for (let n = 2; n <= 20; n++) {
      await occupy(`marie-dupont${n}`);
    }

    const username = await generateUniqueUsername({ displayName: 'Marie Dupont' });

    expect(await User.exists({ username })).toBeNull();
    expect(validateUsername(username)).toBe(true);
  });
});


