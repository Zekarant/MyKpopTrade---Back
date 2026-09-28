import { escapeRegex } from '../escapeRegex';

describe('escapeRegex', () => {
  it('rend littéraux les métacaractères', () => {
    const pattern = new RegExp(`^${escapeRegex('(G)I-DLE')}$`, 'i');

    expect(pattern.test('(g)i-dle')).toBe(true);
    expect(pattern.test('GI-DLE')).toBe(false);
  });

  it('empêche un joker de tout matcher', () => {
    const pattern = new RegExp(escapeRegex('.*'));

    expect(pattern.test('alice')).toBe(false);
    expect(pattern.test('a.*b')).toBe(true);
  });

  it('ne lève pas d\'erreur sur une parenthèse isolée', () => {
    expect(() => new RegExp(escapeRegex('('))).not.toThrow();
  });

  it('laisse inchangée une saisie ordinaire', () => {
    expect(escapeRegex('stray kids')).toBe('stray kids');
  });
});
