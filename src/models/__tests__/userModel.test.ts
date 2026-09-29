import User from '../userModel';

describe('userModel', () => {
  it.each(['user', 'moderator', 'admin'] as const)('accepte le rôle %s', (role) => {
    const user = new User({ username: 'mina', email: 'mina@test.com', password: 'Password1!', role });

    expect(user.validateSync()?.errors.role).toBeUndefined();
  });

  it('refuse un rôle inconnu', () => {
    const user = new User({ username: 'mina', email: 'mina@test.com', password: 'Password1!' });
    user.set('role', 'superadmin');

    expect(user.validateSync()?.errors.role).toBeDefined();
  });
});
