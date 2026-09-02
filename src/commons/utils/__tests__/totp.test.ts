import {
  base32Encode,
  base32Decode,
  generateTotpSecret,
  generateTotpCode,
  currentTimeStep,
  verifyTotpCode,
  buildOtpauthUri,
  type TotpAlgorithm
} from '../totp';

/**
 * Conformité de l'implémentation TOTP aux RFC 4226 et 6238.
 *
 * Les vecteurs de l'annexe B de la RFC 6238 sont la référence : s'ils passent,
 * l'algorithme est correct et interopérable avec Google Authenticator, Authy,
 * 1Password et les autres.
 */
describe('totp', () => {
  describe('base32 (RFC 4648)', () => {
    // Vecteurs de l'annexe 10 de la RFC 4648.
    const vectors: Array<[string, string]> = [
      ['f', 'MY'],
      ['fo', 'MZXQ'],
      ['foo', 'MZXW6'],
      ['foob', 'MZXW6YQ'],
      ['fooba', 'MZXW6YTB'],
      ['foobar', 'MZXW6YTBOI']
    ];

    it.each(vectors)('encode %p en %p', (clear, encoded) => {
      expect(base32Encode(Buffer.from(clear, 'utf8'))).toBe(encoded);
    });

    it.each(vectors)('décode le base32 de %p', (clear, encoded) => {
      expect(base32Decode(encoded).toString('utf8')).toBe(clear);
    });

    it('tolère la casse, les espaces et le remplissage', () => {
      expect(base32Decode('mzxw 6ytb oi==').toString('utf8')).toBe('foobar');
    });

    it('refuse un caractère hors alphabet', () => {
      expect(() => base32Decode('MZXW6YTB!')).toThrow(/base32 invalide/);
    });
  });

  describe('vecteurs de test de la RFC 6238 (annexe B)', () => {
    /**
     * Les secrets de la RFC sont donnés en ASCII ; les applications les
     * échangent en base32. On convertit donc les seeds officiels.
     */
    const SECRETS: Record<TotpAlgorithm, string> = {
      sha1: base32Encode(Buffer.from('12345678901234567890', 'utf8')),
      sha256: base32Encode(Buffer.from('12345678901234567890123456789012', 'utf8')),
      sha512: base32Encode(
        Buffer.from('1234567890123456789012345678901234567890123456789012345678901234', 'utf8')
      )
    };

    // [temps unix, algorithme, code attendu à 8 chiffres]
    const vectors: Array<[number, TotpAlgorithm, string]> = [
      [59, 'sha1', '94287082'],
      [59, 'sha256', '46119246'],
      [59, 'sha512', '90693936'],
      [1111111109, 'sha1', '07081804'],
      [1111111109, 'sha256', '68084774'],
      [1111111109, 'sha512', '25091201'],
      [1111111111, 'sha1', '14050471'],
      [1111111111, 'sha256', '67062674'],
      [1111111111, 'sha512', '99943326'],
      [1234567890, 'sha1', '89005924'],
      [1234567890, 'sha256', '91819424'],
      [1234567890, 'sha512', '93441116'],
      [2000000000, 'sha1', '69279037'],
      [2000000000, 'sha256', '90698825'],
      [2000000000, 'sha512', '38618901'],
      [20000000000, 'sha1', '65353130'],
      [20000000000, 'sha256', '77737706'],
      [20000000000, 'sha512', '47863826']
    ];

    it.each(vectors)('T=%p en %s produit %s', (unixTime, algorithm, expected) => {
      const code = generateTotpCode(
        SECRETS[algorithm],
        currentTimeStep(unixTime),
        algorithm,
        8
      );

      expect(code).toBe(expected);
    });
  });

  describe('génération de secret', () => {
    it('produit un secret base32 de 160 bits', () => {
      const secret = generateTotpSecret();

      expect(secret).toMatch(/^[A-Z2-7]+$/);
      expect(base32Decode(secret)).toHaveLength(20);
    });

    it('produit un secret différent à chaque appel', () => {
      expect(generateTotpSecret()).not.toBe(generateTotpSecret());
    });
  });

  describe('vérification', () => {
    const secret = generateTotpSecret();
    const NOW = 1_700_000_000;

    it('accepte le code du pas de temps courant', () => {
      const code = generateTotpCode(secret, currentTimeStep(NOW));

      const result = verifyTotpCode(secret, code, { unixTimeSeconds: NOW });

      expect(result).toMatchObject({ valid: true, delta: 0 });
    });

    it('accepte une dérive d\'horloge d\'un pas dans les deux sens', () => {
      const previous = generateTotpCode(secret, currentTimeStep(NOW) - 1);
      const next = generateTotpCode(secret, currentTimeStep(NOW) + 1);

      expect(verifyTotpCode(secret, previous, { unixTimeSeconds: NOW })).toMatchObject({
        valid: true,
        delta: -1
      });
      expect(verifyTotpCode(secret, next, { unixTimeSeconds: NOW })).toMatchObject({
        valid: true,
        delta: 1
      });
    });

    it('refuse au-delà de la tolérance', () => {
      const tooOld = generateTotpCode(secret, currentTimeStep(NOW) - 5);

      expect(verifyTotpCode(secret, tooOld, { unixTimeSeconds: NOW })).toEqual({ valid: false });
    });

    it('refuse un code du mauvais secret', () => {
      const other = generateTotpCode(generateTotpSecret(), currentTimeStep(NOW));

      expect(verifyTotpCode(secret, other, { unixTimeSeconds: NOW })).toEqual({ valid: false });
    });

    it('refuse une saisie mal formée sans lever d\'exception', () => {
      for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 56', '<script>']) {
        expect(verifyTotpCode(secret, bad, { unixTimeSeconds: NOW })).toEqual({ valid: false });
      }
    });

    it('refuse le rejeu d\'un pas de temps déjà consommé', () => {
      const timeStep = currentTimeStep(NOW);
      const code = generateTotpCode(secret, timeStep);

      const first = verifyTotpCode(secret, code, { unixTimeSeconds: NOW });
      expect(first).toMatchObject({ valid: true, timeStep });

      const replay = verifyTotpCode(secret, code, {
        unixTimeSeconds: NOW,
        afterTimeStep: timeStep
      });
      expect(replay).toEqual({ valid: false });
    });

    it('accepte encore le pas suivant après consommation du pas courant', () => {
      const timeStep = currentTimeStep(NOW);
      const nextCode = generateTotpCode(secret, timeStep + 1);

      const result = verifyTotpCode(secret, nextCode, {
        unixTimeSeconds: NOW,
        afterTimeStep: timeStep
      });

      expect(result).toMatchObject({ valid: true, timeStep: timeStep + 1 });
    });
  });

  describe('URI otpauth', () => {
    it('produit une URI lisible par les applications d\'authentification', () => {
      const uri = buildOtpauthUri({
        secret: 'JBSWY3DPEHPK3PXP',
        label: 'colin@exemple.com',
        issuer: 'MyKpopTrade'
      });

      expect(uri.startsWith('otpauth://totp/MyKpopTrade:colin%40exemple.com?')).toBe(true);
      expect(uri).toContain('secret=JBSWY3DPEHPK3PXP');
      expect(uri).toContain('issuer=MyKpopTrade');
      expect(uri).toContain('algorithm=SHA1');
      expect(uri).toContain('digits=6');
      expect(uri).toContain('period=30');
    });
  });
});
