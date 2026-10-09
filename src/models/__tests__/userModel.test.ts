import User from '../userModel';

describe('userModel', () => {
  it.each(['user', 'moderator', 'admin'] as const)('accepte le rôle %s', async (role) => {
    const user = new User({ username: 'mina', email: 'mina@test.com', password: 'Password1!', role });

    await expect(user.validate(['role'])).resolves.toBeUndefined();
  });

  it('refuse un rôle inconnu', async () => {
    const user = new User({ username: 'mina', email: 'mina@test.com', password: 'Password1!' });
    user.set('role', 'superadmin');

    await expect(user.validate(['role'])).rejects.toMatchObject({ errors: { role: expect.anything() } });
  });

  it('refuse sans délai un email conçu pour faire backtracker la regex', async () => {
    const user = new User({ username: 'mina', email: `${'a'.repeat(40)}!@b.co`, password: 'Password1!' });

    const startedAt = Date.now();
    await expect(user.validate(['email'])).rejects.toMatchObject({ errors: { email: expect.anything() } });
    expect(Date.now() - startedAt).toBeLessThan(100);
  });
});
