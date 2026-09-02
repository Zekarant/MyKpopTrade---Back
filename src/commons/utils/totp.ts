import crypto from 'crypto';

/**
 * TOTP — mots de passe à usage unique basés sur le temps (RFC 6238), au-dessus
 * de HOTP (RFC 4226).
 *
 * Pourquoi une implémentation locale plutôt qu'une bibliothèque : `otplib` tire
 * `@scure/base` et `@noble/hashes`, publiés uniquement en ESM. Node 24 sait les
 * charger via `require()`, mais pas le runtime CommonJS de Jest, ce qui imposait
 * des contournements de configuration fragiles dans la chaîne de test.
 *
 * Ce module n'invente aucune primitive cryptographique : le HMAC vient de
 * `crypto` (OpenSSL), et l'algorithme est celui, entièrement spécifié, des RFC.
 * Sa conformité est vérifiée dans les tests contre les vecteurs officiels
 * publiés à l'annexe B de la RFC 6238.
 */

/** Durée d'un pas de temps, en secondes (valeur standard, attendue par les apps). */
const PERIOD_SECONDS = 30;

/** Nombre de chiffres du code (valeur standard). */
const DIGITS = 6;

/** Taille du secret généré, en octets. La RFC 4226 recommande 20 octets (160 bits). */
const SECRET_BYTES = 20;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export type TotpAlgorithm = 'sha1' | 'sha256' | 'sha512';

/** Encode des octets en base32 (RFC 4648), sans caractère de remplissage. */
export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

/**
 * Décode une chaîne base32 (RFC 4648). Tolère la casse, les espaces et le
 * remplissage `=`, que les utilisateurs recopient parfois.
 */
export function base32Decode(input: string): Buffer {
  const normalized = input.toUpperCase().replace(/[\s=]/g, '');
  let bits = 0;
  let value = 0;
  const output: number[] = [];

  for (const char of normalized) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error(`Caractère base32 invalide : ${char}`);
    }

    value = (value << 5) | index;
    bits += 5;

    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(output);
}

/** Génère un secret partagé, encodé en base32 pour les applications d'authentification. */
export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(SECRET_BYTES));
}

/** Pas de temps courant : T = floor(unixTime / période), cf. RFC 6238 §4.2. */
export function currentTimeStep(unixTimeSeconds: number = Math.floor(Date.now() / 1000)): number {
  return Math.floor(unixTimeSeconds / PERIOD_SECONDS);
}

/**
 * Calcule le code HOTP d'un compteur donné (RFC 4226 §5.3).
 * Pour TOTP, le compteur est le pas de temps.
 */
export function generateTotpCode(
  secret: string,
  timeStep: number = currentTimeStep(),
  algorithm: TotpAlgorithm = 'sha1',
  digits: number = DIGITS
): string {
  // Compteur sur 8 octets, big-endian.
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(timeStep));

  const hmac = crypto.createHmac(algorithm, base32Decode(secret)).update(counter).digest();

  // Troncature dynamique : les 4 bits de poids faible du dernier octet donnent
  // l'offset de lecture, et le bit de poids fort est masqué (RFC 4226 §5.4).
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    (hmac[offset + 1] << 16) |
    (hmac[offset + 2] << 8) |
    hmac[offset + 3];

  return (binary % 10 ** digits).toString().padStart(digits, '0');
}

export interface TotpVerifyOptions {
  /** Nombre de pas de temps acceptés de part et d'autre du pas courant. */
  tolerance?: number;
  /**
   * Pas de temps déjà consommé. Tout code appartenant à ce pas ou à un pas
   * antérieur est refusé, ce qui empêche le rejeu d'un code intercepté pendant
   * sa fenêtre de validité.
   */
  afterTimeStep?: number;
  /** Horodatage de référence, en secondes. Injectable pour les tests. */
  unixTimeSeconds?: number;
  algorithm?: TotpAlgorithm;
  digits?: number;
}

export type TotpVerifyResult =
  | { valid: false }
  | { valid: true; timeStep: number; delta: number };

/**
 * Vérifie un code TOTP.
 *
 * La comparaison des codes est faite à temps constant : le code attendu est un
 * secret dérivé, et une comparaison paresseuse fuiterait la longueur du préfixe
 * correct.
 */
export function verifyTotpCode(
  secret: string,
  token: string,
  options: TotpVerifyOptions = {}
): TotpVerifyResult {
  const {
    tolerance = 1,
    afterTimeStep,
    unixTimeSeconds,
    algorithm = 'sha1',
    digits = DIGITS
  } = options;

  const submitted = token.trim();
  if (!new RegExp(`^\\d{${digits}}$`).test(submitted)) {
    return { valid: false };
  }

  const current = currentTimeStep(unixTimeSeconds);
  const submittedBuffer = Buffer.from(submitted, 'utf8');

  for (let delta = -tolerance; delta <= tolerance; delta++) {
    const timeStep = current + delta;

    if (timeStep < 0) continue;
    // Rejeu : ce pas de temps a déjà servi.
    if (afterTimeStep !== undefined && timeStep <= afterTimeStep) continue;

    const expected = Buffer.from(generateTotpCode(secret, timeStep, algorithm, digits), 'utf8');
    if (
      expected.length === submittedBuffer.length &&
      crypto.timingSafeEqual(expected, submittedBuffer)
    ) {
      return { valid: true, timeStep, delta };
    }
  }

  return { valid: false };
}

/**
 * Construit l'URI `otpauth://` que les applications d'authentification lisent
 * depuis un QR code (format « Key Uri » de Google Authenticator).
 */
export function buildOtpauthUri(options: {
  secret: string;
  label: string;
  issuer: string;
  algorithm?: TotpAlgorithm;
  digits?: number;
}): string {
  const { secret, label, issuer, algorithm = 'sha1', digits = DIGITS } = options;

  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: algorithm.toUpperCase(),
    digits: String(digits),
    period: String(PERIOD_SECONDS)
  });

  // Le label est préfixé par l'émetteur, séparé par « : » — les deux parties
  // doivent être encodées pour ne pas casser l'URI.
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}?${params.toString()}`;
}
