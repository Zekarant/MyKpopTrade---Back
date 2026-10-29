import { SELLER_CARD_FIELDS, USER_CARD_FIELDS, VERIFIED_USER_CARD_FIELDS } from '../userFields';

/**
 * Cartes de membre exposées publiquement : les champs sont figés ici pour qu'un
 * ajout (et a fortiori un champ privé) soit toujours une décision visible.
 */
describe('cartes de membre', () => {
  it('n\'exposent que le pseudo, l\'avatar, le badge vérifié et la note du vendeur', () => {
    expect(USER_CARD_FIELDS).toBe('username profilePicture');
    expect(VERIFIED_USER_CARD_FIELDS).toBe('username profilePicture isIdentityVerified');
    expect(SELLER_CARD_FIELDS).toBe('username profilePicture isIdentityVerified statistics.averageRating');
  });
});
