import { add, ceilToCents, percentOf, roundToCents, subtract } from '../moneyMath';

/** Montants au centime : calculs sans les erreurs des flottants. */

describe('moneyMath', () => {
  it('roundToCents arrondit au centime le plus proche', () => {
    expect(roundToCents(2.345)).toBe(2.35);
    expect(roundToCents(2.344)).toBe(2.34);
    expect(roundToCents(0.1 + 0.2)).toBe(0.3);
  });

  it('ceilToCents arrondit au centime supérieur, sans monter un montant déjà exact', () => {
    expect(ceilToCents(9.995)).toBe(10);
    expect(ceilToCents(19.99 * 50 / 100)).toBe(10);
    expect(ceilToCents(0.1 * 3)).toBe(0.3);
    expect(ceilToCents(12)).toBe(12);
  });

  it('percentOf arrondit la demi-centime vers le haut, sans erreur de flottant (commission plateforme)', () => {
    expect(percentOf(1.45, 10)).toBe(0.15);
    expect(percentOf(2.85, 10)).toBe(0.29);
    expect(percentOf(5.65, 10)).toBe(0.57);
    expect(percentOf(2.9, 5)).toBe(0.15);
    expect(percentOf(5.7, 5)).toBe(0.29);
    expect(percentOf(100, 2.5)).toBe(2.5);
  });

  it('add / subtract travaillent en centimes', () => {
    expect(add(0.1, 0.2)).toBe(0.3);
    expect(subtract(10, 9.99)).toBe(0.01);
  });

  it('refuse un montant non fini', () => {
    expect(() => ceilToCents(Number.NaN)).toThrow('Montant invalide');
    expect(() => roundToCents(Infinity)).toThrow('Montant invalide');
  });
});
