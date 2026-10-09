import { matchesCriteria, toGroupKeys, groupKeysForProduct, MatchableProduct, ProductCatalogIds } from '../matcher';
import { ANY_GROUP_KEY } from '../model';
import type { SavedSearchCriteria } from '../validation';

const GROUP_ID = '64b000000000000000000001';
const ALBUM_ID = '64b000000000000000000002';

const aProduct = (overrides: Partial<MatchableProduct> = {}): MatchableProduct => ({
  title: 'Photocard Jungkook Golden',
  description: 'Officielle, jamais sortie du sleeve',
  price: 20,
  currency: 'EUR',
  condition: 'likeNew',
  type: 'photocard',
  kpopGroup: 'BTS',
  kpopMember: 'Jungkook',
  albumName: 'Golden',
  ...overrides
});

const noCatalogIds: ProductCatalogIds = { groupIds: [], albumIds: [] };
const matches = (criteria: SavedSearchCriteria, product = aProduct(), catalogIds = noCatalogIds) =>
  matchesCriteria(criteria, product, catalogIds);

describe('matchesCriteria', () => {
  it('trouve le texte cherché sans tenir compte de la casse, dans tous les champs texte', () => {
    expect(matches({ query: 'golden' }, aProduct({ title: 'Photocard' }))).toBe(true);
    expect(matches({ query: 'SLEEVE' })).toBe(true);
    expect(matches({ query: 'twice' })).toBe(false);
  });

  it('compare groupes, membres et albums par nom à l\'identique, sans casse', () => {
    expect(matches({ groups: ['bts'] })).toBe(true);
    expect(matches({ groups: ['BT'] })).toBe(false);
    expect(matches({ members: ['jimin'] })).toBe(false);
    expect(matches({ albums: ['GOLDEN'] })).toBe(true);
  });

  it('exige un membre quand la recherche en vise un', () => {
    expect(matches({ members: ['Jungkook'] }, aProduct({ kpopMember: undefined }))).toBe(false);
  });

  it('applique type, état et devise', () => {
    expect(matches({ type: 'album' })).toBe(false);
    expect(matches({ condition: ['new', 'likeNew'] })).toBe(true);
    expect(matches({ condition: ['new'] })).toBe(false);
    expect(matches({ currency: 'USD' })).toBe(false);
  });

  it('inclut les bornes de la fourchette de prix', () => {
    expect(matches({ priceRange: { min: 20, max: 20 } })).toBe(true);
    expect(matches({ priceRange: { max: 19.99 } })).toBe(false);
    expect(matches({ priceRange: { min: 20.01 } })).toBe(false);
  });

  it('exige que tous les critères soient remplis', () => {
    expect(matches({ groups: ['BTS'], type: 'album' })).toBe(false);
  });
});

describe('matchesCriteria — critères du catalogue', () => {
  it('retrouve le groupe et l\'album par les identifiants résolus pour l\'annonce', () => {
    const catalogIds = { groupIds: [GROUP_ID], albumIds: [ALBUM_ID] };

    expect(matches({ group: GROUP_ID, album: ALBUM_ID }, aProduct(), catalogIds)).toBe(true);
    expect(matches({ group: GROUP_ID }, aProduct(), noCatalogIds)).toBe(false);
  });

  it('retrouve le membre dans le champ structuré ou, à défaut, dans kpopMember (casse exacte)', () => {
    expect(matches({ member: 'Jungkook' }, aProduct({ kpopMember: undefined, member: 'Jungkook' }))).toBe(true);
    expect(matches({ member: 'Jungkook' }, aProduct({ member: undefined }))).toBe(true);
    expect(matches({ member: 'jungkook' })).toBe(false);
  });

  it('applique version et « officiel » à l\'identique', () => {
    expect(matches({ version: 'Weverse' }, aProduct({ version: 'Weverse' }))).toBe(true);
    expect(matches({ version: 'Weverse' }, aProduct({ version: 'Apple Music' }))).toBe(false);
    expect(matches({ isOfficial: true }, aProduct({ isOfficial: true }))).toBe(true);
    // Comme `{ isOfficial: false }` en Mongo : une annonce sans l'information ne correspond pas.
    expect(matches({ isOfficial: false }, aProduct())).toBe(false);
  });
});

describe('clés de groupe', () => {
  it('range une recherche sous son groupe du catalogue, ses noms de groupe ou « tous groupes »', () => {
    expect(toGroupKeys({ group: GROUP_ID, groups: ['BTS'] })).toEqual([`group:${GROUP_ID}`]);
    expect(toGroupKeys({ groups: ['BTS', 'bts', 'Twice'] })).toEqual(['bts', 'twice']);
    expect(toGroupKeys({})).toEqual([ANY_GROUP_KEY]);
  });

  it('fait correspondre une annonce aux recherches de son groupe, par nom ou identifiant, et à celles sans groupe', () => {
    expect(groupKeysForProduct({ kpopGroup: ' BTS ' }, { groupIds: [GROUP_ID], albumIds: [] }))
      .toEqual([ANY_GROUP_KEY, 'bts', `group:${GROUP_ID}`]);
  });
});
