import { isObjectIdString, queryInt, queryString } from '../query';

describe('isObjectIdString', () => {
  it('accepte une chaîne qu\'ObjectId reconnaît, refuse le reste', () => {
    expect(isObjectIdString('507f1f77bcf86cd799439011')).toBe(true);
    expect(isObjectIdString('pas-un-id')).toBe(false);
    expect(isObjectIdString(['507f1f77bcf86cd799439011'])).toBe(false);
    expect(isObjectIdString(undefined)).toBe(false);
  });
});

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
