import { queryInt, queryString } from '../query';

describe('queryString', () => {
  it('garde une valeur unique', () => {
    expect(queryString('pending')).toBe('pending');
  });

  it('ignore un paramètre répété ou absent', () => {
    expect(queryString(['pending', 'completed'])).toBeUndefined();
    expect(queryString(undefined)).toBeUndefined();
  });
});

describe('queryInt', () => {
  it('lit un entier', () => {
    expect(queryInt('3')).toBe(3);
  });

  it('rend NaN si absent, répété ou invalide', () => {
    expect(queryInt(undefined)).toBeNaN();
    expect(queryInt(['2', '3'])).toBeNaN();
    expect(queryInt('abc')).toBeNaN();
  });
});
