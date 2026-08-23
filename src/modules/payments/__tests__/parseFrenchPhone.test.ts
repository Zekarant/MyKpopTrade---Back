import { parseFrenchPhone } from '../services/paypalPartnerService';

/**
 * Le numéro pré-rempli part dans la « create partner referral ». Un numéro mal
 * découpé fait échouer l'appel entier avec un 400 et bloque l'onboarding du
 * vendeur : mieux vaut renvoyer `null` que produire un format douteux.
 */
describe('parseFrenchPhone', () => {
  const expected = { country_code: '33', national_number: '612345678' };

  it.each([
    ['format international +33', '+33612345678'],
    ['format international 0033', '0033612345678'],
    ['format national', '0612345678'],
    ['espaces', '06 12 34 56 78'],
    ['points', '06.12.34.56.78'],
    ['tirets et indicatif', '+33 6-12-34-56-78']
  ])('découpe un numéro au %s', (_label, input) => {
    expect(parseFrenchPhone(input)).toEqual(expected);
  });

  it('accepte un fixe', () => {
    expect(parseFrenchPhone('01 23 45 67 89')).toEqual({
      country_code: '33',
      national_number: '123456789'
    });
  });

  it.each([
    ['undefined', undefined],
    ['chaîne vide', ''],
    ['trop court', '0612345'],
    ['trop long', '06123456789'],
    ['sans préfixe reconnaissable', '5551234'],
    ['numéro étranger', '+44 20 7946 0958'],
    ['texte', 'pas un numéro']
  ])('renvoie null pour %s', (_label, input) => {
    expect(parseFrenchPhone(input as string | undefined)).toBeNull();
  });
});
