import { calculateProfileCompleteness } from '../profileService';
import type { IUser } from '../../../../models/userModel';

function makeUser(overrides: Partial<IUser> = {}): IUser {
  return overrides as IUser;
}

describe('calculateProfileCompleteness', () => {
  it('retourne 0 pour un utilisateur totalement vide', () => {
    expect(calculateProfileCompleteness(makeUser())).toBe(0);
  });

  it('retourne 100 pour un profil totalement rempli', () => {
    const user = makeUser({
      profilePicture: '/img.jpg',
      bio: 'Hello',
      location: 'Paris',
      preferences: { kpopGroups: ['BTS'] } as any,
      socialLinks: {
        instagram: 'insta',
        twitter: 'twit',
        discord: 'disc'
      } as any,
      isEmailVerified: true,
      isPhoneVerified: true
    });

    expect(calculateProfileCompleteness(user)).toBe(100);
  });

  it('ne compte pas un champ booléen à false', () => {
    const user = makeUser({
      isEmailVerified: false,
      isPhoneVerified: false
    });
    expect(calculateProfileCompleteness(user)).toBe(0);
  });

  it('ne compte pas un tableau vide pour les kpopGroups', () => {
    const user = makeUser({
      preferences: { kpopGroups: [] } as any
    });
    expect(calculateProfileCompleteness(user)).toBe(0);
  });

  it('donne 15 points pour la bio seule', () => {
    expect(calculateProfileCompleteness(makeUser({ bio: 'Hi' }))).toBe(15);
  });

  it('donne 20 points pour email vérifié seul', () => {
    expect(calculateProfileCompleteness(makeUser({ isEmailVerified: true }))).toBe(20);
  });

  it('cumule correctement bio + location', () => {
    const user = makeUser({ bio: 'Hi', location: 'Paris' });
    expect(calculateProfileCompleteness(user)).toBe(25);
  });

  it('ignore les champs undefined dans les objets imbriqués', () => {
    const user = makeUser({
      socialLinks: { instagram: 'insta' } as any
    });
    expect(calculateProfileCompleteness(user)).toBe(5);
  });

  it('ne compte pas une chaîne vide', () => {
    expect(calculateProfileCompleteness(makeUser({ bio: '' }))).toBe(0);
  });
});
