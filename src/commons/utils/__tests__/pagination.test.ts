import { clampLimit } from '../pagination';

describe('clampLimit', () => {
  it('garde une valeur dans les bornes', () => {
    expect(clampLimit('50', 20, 500)).toBe(50);
  });

  it('plafonne une valeur excessive', () => {
    expect(clampLimit('100000', 20, 500)).toBe(500);
  });

  it.each([undefined, '', 'abc', '0', '-3', null])(
    'retombe sur la valeur par défaut pour %p',
    (raw) => {
      expect(clampLimit(raw, 20, 500)).toBe(20);
    }
  );

  it('accepte un nombre déjà typé', () => {
    expect(clampLimit(12, 20, 500)).toBe(12);
  });
});
