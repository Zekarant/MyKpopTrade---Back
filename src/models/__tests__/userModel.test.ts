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
});
