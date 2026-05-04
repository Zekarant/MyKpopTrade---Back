import {
  hasOfferHistory,
  getOfferCount,
  isArchivedByUser,
  isFavoritedByUser,
  formatOfferHistory
} from '../conversationTypes';

describe('hasOfferHistory', () => {
  it('true si offerHistory est un tableau (même vide)', () => {
    expect(hasOfferHistory({ offerHistory: [] })).toBe(true);
    expect(hasOfferHistory({ offerHistory: [{ amount: 10 }] })).toBe(true);
  });

  it('false si absent ou non-tableau', () => {
    expect(hasOfferHistory({})).toBe(false);
    expect(hasOfferHistory({ offerHistory: null })).toBe(false);
    expect(hasOfferHistory({ offerHistory: 'not-array' })).toBe(false);
    expect(hasOfferHistory(null)).toBe(false);
    expect(hasOfferHistory(undefined)).toBe(false);
  });
});

describe('getOfferCount', () => {
  it('retourne la longueur quand offerHistory existe', () => {
    expect(getOfferCount({ offerHistory: [1, 2, 3] })).toBe(3);
    expect(getOfferCount({ offerHistory: [] })).toBe(0);
  });

  it('retourne 0 si offerHistory est absent', () => {
    expect(getOfferCount({})).toBe(0);
    expect(getOfferCount(null)).toBe(0);
  });
});

describe('isArchivedByUser', () => {
  it('true si l\'userId est dans archivedBy', () => {
    const conv = { archivedBy: [{ toString: () => 'user123' }] };
    expect(isArchivedByUser(conv, 'user123')).toBe(true);
  });

  it('false sinon', () => {
    const conv = { archivedBy: [{ toString: () => 'otherUser' }] };
    expect(isArchivedByUser(conv, 'user123')).toBe(false);
  });

  it('false si archivedBy absent ou non-array', () => {
    expect(isArchivedByUser({}, 'user123')).toBe(false);
    expect(isArchivedByUser({ archivedBy: null }, 'user123')).toBe(false);
    expect(isArchivedByUser(null, 'user123')).toBe(false);
  });
});

describe('isFavoritedByUser', () => {
  it('true si userId est dans favoritedBy', () => {
    const conv = { favoritedBy: [{ toString: () => 'u1' }, { toString: () => 'u2' }] };
    expect(isFavoritedByUser(conv, 'u2')).toBe(true);
  });

  it('false sinon', () => {
    expect(isFavoritedByUser({ favoritedBy: [] }, 'u1')).toBe(false);
    expect(isFavoritedByUser({}, 'u1')).toBe(false);
  });
});

describe('formatOfferHistory', () => {
  it('retourne un tableau vide si pas d\'historique', () => {
    expect(formatOfferHistory({}, 'u1')).toEqual([]);
    expect(formatOfferHistory({ offerHistory: null }, 'u1')).toEqual([]);
  });

  it('marque isCurrentUserOffer selon l\'auteur', () => {
    const conv = {
      offerHistory: [
        { amount: 10, offeredBy: { _id: { toString: () => 'u1' } } },
        { amount: 20, offeredBy: { _id: { toString: () => 'u2' } } }
      ]
    };

    const result = formatOfferHistory(conv, 'u1');
    expect(result[0].isCurrentUserOffer).toBe(true);
    expect(result[1].isCurrentUserOffer).toBe(false);
  });

  it('ajoute formattedAmount avec la devise par défaut EUR', () => {
    const conv = {
      offerHistory: [{ amount: 15, offeredBy: { _id: { toString: () => 'u1' } } }]
    };
    const result = formatOfferHistory(conv, 'u1');
    expect(result[0].formattedAmount).toBe('15 EUR');
  });

  it('respecte une devise personnalisée', () => {
    const conv = {
      offerHistory: [{ amount: 30, offeredBy: { _id: { toString: () => 'u1' } } }]
    };
    const result = formatOfferHistory(conv, 'u1', 'USD');
    expect(result[0].formattedAmount).toBe('30 USD');
  });

  it('isCurrentUserOffer false si offeredBy._id absent', () => {
    const conv = {
      offerHistory: [{ amount: 5, offeredBy: {} }]
    };
    const result = formatOfferHistory(conv, 'u1');
    expect(result[0].isCurrentUserOffer).toBe(false);
  });
});
