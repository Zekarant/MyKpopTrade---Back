import crypto from 'crypto';
import { EncryptionService } from '../encryptionService';

/**
 * Ces tests verrouillent deux propriétés du chiffrement des données personnelles.
 *
 * 1. Non-déterminisme. L'implémentation d'origine réutilisait un IV FIXE lu dans
 *    `ENCRYPTION_IV` : deux valeurs identiques produisaient le même chiffré, ce
 *    qui révèle leur égalité à quiconque lit la base (par exemple : deux
 *    paiements anonymisés portant la même adresse).
 *
 * 2. Compatibilité ascendante. Les données déjà chiffrées avec l'ancien format
 *    doivent rester déchiffrables, sinon l'anonymisation RGPD des paiements de
 *    plus de 3 ans casse sur l'historique.
 */
describe('EncryptionService', () => {
  const KEY = process.env.ENCRYPTION_KEY;
  const IV = process.env.ENCRYPTION_IV;

  // Les tests n'ont de sens qu'avec une clé configurée (cas du .env local et de
  // la production ; ignorés sur un environnement sans clé).
  const hasKey = Boolean(KEY && KEY.length >= 32);
  const maybe = hasKey ? describe : describe.skip;

  maybe('aller-retour', () => {
    it('déchiffre ce qu\'il a chiffré (chaîne)', () => {
      const clear = '12 rue de la Paix, 75002 Paris';
      expect(EncryptionService.decrypt(EncryptionService.encrypt(clear))).toBe(clear);
    });

    it('déchiffre ce qu\'il a chiffré (objet JSON)', () => {
      const clear = { amount: 24.5, currency: 'EUR', buyer: 'user-42' };
      expect(EncryptionService.decrypt(EncryptionService.encrypt(clear))).toEqual(clear);
    });
  });

  maybe('non-déterminisme', () => {
    it('produit deux chiffrés DIFFÉRENTS pour la même valeur', () => {
      const clear = 'valeur identique';

      const first = EncryptionService.encrypt(clear);
      const second = EncryptionService.encrypt(clear);

      // C'est exactement ce que l'IV fixe empêchait.
      expect(first).not.toBe(second);

      // Les deux restent déchiffrables vers la même valeur.
      expect(EncryptionService.decrypt(first)).toBe(clear);
      expect(EncryptionService.decrypt(second)).toBe(clear);
    });

    it('émet le format versionné v2:<iv>:<chiffré>', () => {
      const parts = EncryptionService.encrypt('x').split(':');

      expect(parts).toHaveLength(3);
      expect(parts[0]).toBe('v2');
      // IV de 16 octets en hexadécimal.
      expect(parts[1]).toMatch(/^[0-9a-f]{32}$/);
    });
  });

  const maybeLegacy = hasKey && IV && IV.length >= 16 ? describe : describe.skip;

  maybeLegacy('compatibilité avec le format historique', () => {
    /** Reproduit l'ancien chiffrement : IV fixe, pas de préfixe de format. */
    function encryptLegacy(clear: string): string {
      const key = Buffer.from((KEY as string).slice(0, 32), 'utf8');
      const iv = Buffer.from((IV as string).slice(0, 16), 'utf8');
      const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
      let encrypted = cipher.update(clear, 'utf8', 'hex');
      encrypted += cipher.final('hex');
      return encrypted;
    }

    it('déchiffre une donnée écrite avant le changement de format', () => {
      const clear = 'donnee-historique-en-base';

      expect(EncryptionService.decrypt(encryptLegacy(clear))).toBe(clear);
    });

    it('déchiffre un objet JSON historique', () => {
      const clear = { transactionReference: 'PAY-123', amount: 19.9 };

      expect(EncryptionService.decrypt(encryptLegacy(JSON.stringify(clear)))).toEqual(clear);
    });
  });
});
