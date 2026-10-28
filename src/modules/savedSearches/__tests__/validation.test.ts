import { validateSavedSearchCreate, validateSavedSearchUpdate } from '../validation';

describe('validateSavedSearchCreate', () => {
  it('retire les critères vides envoyés par la page de recherche', () => {
    const { value } = validateSavedSearchCreate({
      name: '  BTS  ',
      criteria: { query: '  ', groups: ['BTS'], members: [], priceRange: { min: 0, max: 50 }, condition: [] }
    });

    expect(value).toEqual({ name: 'BTS', criteria: { groups: ['BTS'], priceRange: { min: 0, max: 50 } } });
  });

  it('refuse une recherche sans aucun critère', () => {
    const { error } = validateSavedSearchCreate({ name: 'Tout', criteria: { query: '', groups: [] } });

    expect(error).toMatch(/au moins un critère/);
  });

  it('refuse un critère hors liste blanche en nommant le champ', () => {
    const { error } = validateSavedSearchCreate({ name: 'X', criteria: { query: 'bts', seller: 'abc' } });

    expect(error).toMatch(/seller/);
  });

  it('refuse une fourchette de prix inversée', () => {
    const { error } = validateSavedSearchCreate({ name: 'X', criteria: { priceRange: { min: 50, max: 10 } } });

    expect(error).toMatch(/^criteria\.priceRange/);
  });

  it('accepte les critères du catalogue, « officiel = non » compris', () => {
    const criteria = { group: '64b000000000000000000001', member: ' Jungkook ', album: '64b000000000000000000002', version: 'Weverse', isOfficial: false };

    expect(validateSavedSearchCreate({ name: 'X', criteria }).value?.criteria)
      .toEqual({ ...criteria, member: 'Jungkook' });
  });

  it('refuse un identifiant de groupe ou d\'album mal formé', () => {
    expect(validateSavedSearchCreate({ name: 'X', criteria: { group: 'BTS' } }).error).toMatch(/^criteria\.group/);
    expect(validateSavedSearchCreate({ name: 'X', criteria: { album: { $ne: null } } }).error).toMatch(/^criteria\.album/);
  });

  it('refuse un état ou un type inconnu', () => {
    expect(validateSavedSearchCreate({ name: 'X', criteria: { condition: ['mint'] } }).error).toBeDefined();
    expect(validateSavedSearchCreate({ name: 'X', criteria: { type: 'poster' } }).error).toBeDefined();
  });
});

describe('validateSavedSearchUpdate', () => {
  it('n\'accepte que le nom et les alertes', () => {
    expect(validateSavedSearchUpdate({ alertsEnabled: false }).value).toEqual({ alertsEnabled: false });
    expect(validateSavedSearchUpdate({ criteria: { query: 'bts' } }).error).toMatch(/criteria/);
  });

  it('refuse une modification vide', () => {
    expect(validateSavedSearchUpdate({}).error).toMatch(/Aucune modification/);
  });
});
