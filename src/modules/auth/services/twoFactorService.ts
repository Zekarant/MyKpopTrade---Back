import crypto from 'crypto';
import QRCode from 'qrcode';
import {
  generateTotpSecret,
  verifyTotpCode,
  buildOtpauthUri
} from '../../../commons/utils/totp';
import User, { IUser } from '../../../models/userModel';
import { EncryptionService } from '../../../commons/utils/encryptionService';
import { HttpError } from '../../../commons/utils/httpError';
import logger from '../../../commons/utils/logger';

/**
 * Double authentification par TOTP (RFC 6238).
 *
 * Choix d'implémentation :
 * - le secret est chiffré au repos (c'est un identifiant d'authentification) ;
 * - les codes de secours sont stockés hachés en SHA-256, jamais en clair ;
 * - un code déjà consommé est refusé (`afterTimeStep`), ce qui bloque le rejeu
 *   d'un code intercepté pendant sa fenêtre de validité de 30 secondes ;
 * - l'activation se fait en deux temps (secret en attente, puis confirmation par
 *   un code valide) pour ne jamais verrouiller un compte dont l'utilisateur
 *   n'aurait pas réussi à enregistrer le secret dans son application.
 */

/** Nom affiché dans l'application d'authentification. */
const ISSUER = 'MyKpopTrade';

/** Nombre de codes de secours générés à l'activation. */
const RECOVERY_CODE_COUNT = 8;

/**
 * Tolérance de dérive d'horloge, en pas de temps de 30 secondes.
 * 1 accepte le code précédent et le suivant, ce qui couvre les horloges de
 * téléphone légèrement décalées sans élargir la fenêtre d'attaque.
 */
const DRIFT_TOLERANCE_STEPS = 1;

/**
 * Hache un code de secours.
 *
 * SHA-256 et non bcrypt : ces codes sont générés aléatoirement sur 80 bits,
 * donc non énumérables par force brute. Le hachage lent de bcrypt protège les
 * secrets à faible entropie choisis par un humain ; il n'apporte rien ici et
 * coûterait 8 comparaisons lentes à chaque tentative de connexion de secours.
 */
function hashRecoveryCode(code: string): string {
  return crypto.createHash('sha256').update(code).digest('hex');
}

/** Génère un code de secours lisible du type `A1B2-C3D4-E5F6`. */
function generateRecoveryCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sans I, O, 0, 1
  const groups: string[] = [];

  for (let group = 0; group < 3; group++) {
    let chunk = '';
    for (let i = 0; i < 4; i++) {
      chunk += alphabet[crypto.randomInt(0, alphabet.length)];
    }
    groups.push(chunk);
  }

  return groups.join('-');
}

/** Charge un utilisateur avec ses champs 2FA, qui sont `select: false`. */
async function loadUserWithTwoFactor(userId: string): Promise<IUser> {
  const user = await User.findById(userId).select(
    '+twoFactor.secret +twoFactor.pendingSecret +twoFactor.recoveryCodes +twoFactor.lastUsedTimeStep'
  );

  if (!user) {
    throw new HttpError(404, 'Utilisateur non trouvé');
  }

  return user;
}

/** Indique si la 2FA est active sur un compte. */
export function isTwoFactorEnabled(user: Pick<IUser, 'twoFactor'>): boolean {
  return user.twoFactor?.enabled === true;
}

/**
 * Prépare l'activation : génère un secret en attente et rend de quoi
 * l'enregistrer dans une application d'authentification.
 *
 * N'active rien : l'utilisateur doit confirmer avec un code valide
 * (cf. `confirmTwoFactorActivation`).
 */
export async function startTwoFactorActivation(userId: string): Promise<{
  qrCodeDataUrl: string;
  secret: string;
  otpauthUri: string;
}> {
  const user = await loadUserWithTwoFactor(userId);

  if (isTwoFactorEnabled(user)) {
    throw new HttpError(409, 'La double authentification est déjà activée sur ce compte.');
  }

  const secret = generateTotpSecret();
  const otpauthUri = buildOtpauthUri({
    secret,
    label: user.email,
    issuer: ISSUER
  });

  user.twoFactor = {
    ...(user.twoFactor ?? { enabled: false }),
    enabled: false,
    pendingSecret: EncryptionService.encrypt(secret)
  };
  await user.save();

  logger.info('Activation 2FA initiée', { userId: userId.substring(0, 5) + '...' });

  return {
    qrCodeDataUrl: await QRCode.toDataURL(otpauthUri, { width: 240, margin: 1 }),
    // Rendu pour la saisie manuelle quand le QR code ne peut pas être scanné.
    secret,
    otpauthUri
  };
}

/**
 * Confirme l'activation avec un premier code valide, puis rend les codes de
 * secours. Ceux-ci ne sont affichés qu'ici : seules leurs empreintes sont
 * conservées.
 */
export async function confirmTwoFactorActivation(
  userId: string,
  code: string
): Promise<{ recoveryCodes: string[] }> {
  const user = await loadUserWithTwoFactor(userId);

  if (isTwoFactorEnabled(user)) {
    throw new HttpError(409, 'La double authentification est déjà activée sur ce compte.');
  }

  const pending = user.twoFactor?.pendingSecret;
  if (!pending) {
    throw new HttpError(
      409,
      "Aucune activation en cours. Relancez la configuration pour obtenir un nouveau QR code."
    );
  }

  const secret = EncryptionService.decrypt(pending) as string;
  const result = verifyTotpCode(secret, code, { tolerance: DRIFT_TOLERANCE_STEPS });

  if (!result.valid) {
    throw new HttpError(400, 'Code invalide. Vérifiez l\'heure de votre téléphone et réessayez.');
  }

  const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);

  user.twoFactor = {
    enabled: true,
    secret: EncryptionService.encrypt(secret),
    pendingSecret: undefined,
    recoveryCodes: recoveryCodes.map(hashRecoveryCode),
    lastUsedTimeStep: result.timeStep,
    enabledAt: new Date()
  };
  await user.save();

  logger.info('2FA activée', { userId: userId.substring(0, 5) + '...' });

  return { recoveryCodes };
}

/**
 * Vérifie un code TOTP ou un code de secours lors de la connexion.
 *
 * Un code de secours est à usage unique : il est retiré de la liste dès qu'il
 * sert. Un code TOTP déjà consommé est refusé, pour qu'un code intercepté ne
 * puisse pas être rejoué dans sa fenêtre de 30 secondes.
 */
export async function verifyTwoFactorCode(
  userId: string,
  code: string
): Promise<{ usedRecoveryCode: boolean; remainingRecoveryCodes: number }> {
  const user = await loadUserWithTwoFactor(userId);

  if (!isTwoFactorEnabled(user) || !user.twoFactor?.secret) {
    throw new HttpError(409, 'La double authentification n\'est pas activée sur ce compte.');
  }

  const submitted = code.trim().toUpperCase();

  // 1. Code de secours ?
  const storedRecoveryCodes = user.twoFactor.recoveryCodes ?? [];
  const submittedHash = hashRecoveryCode(submitted);
  const submittedBuffer = Buffer.from(submittedHash, 'hex');
  const matchIndex = storedRecoveryCodes.findIndex((stored) => {
    const storedBuffer = Buffer.from(stored, 'hex');
    // timingSafeEqual lève si les longueurs diffèrent : on écarte d'abord tout
    // enregistrement malformé plutôt que de laisser remonter une exception.
    if (storedBuffer.length !== submittedBuffer.length) return false;
    return crypto.timingSafeEqual(storedBuffer, submittedBuffer);
  });

  if (matchIndex !== -1) {
    const remaining = storedRecoveryCodes.filter((_, i) => i !== matchIndex);
    user.twoFactor.recoveryCodes = remaining;
    await user.save();

    logger.warn('Connexion via code de secours 2FA', {
      userId: userId.substring(0, 5) + '...',
      remainingRecoveryCodes: remaining.length
    });

    return { usedRecoveryCode: true, remainingRecoveryCodes: remaining.length };
  }

  // 2. Code TOTP
  const secret = EncryptionService.decrypt(user.twoFactor.secret) as string;
  const result = verifyTotpCode(secret, submitted, {
    tolerance: DRIFT_TOLERANCE_STEPS,
    // Refuse tout code appartenant à un pas de temps déjà consommé.
    afterTimeStep: user.twoFactor.lastUsedTimeStep
  });

  if (!result.valid) {
    throw new HttpError(401, 'Code de vérification invalide.');
  }

  user.twoFactor.lastUsedTimeStep = result.timeStep;
  await user.save();

  return { usedRecoveryCode: false, remainingRecoveryCodes: storedRecoveryCodes.length };
}

/**
 * Désactive la 2FA. Exige le mot de passe ET un code valide : sans cela, un
 * accès temporaire à une session suffirait à retirer le second facteur.
 */
export async function disableTwoFactor(
  userId: string,
  password: string,
  code: string
): Promise<void> {
  const user = await User.findById(userId).select(
    '+password +twoFactor.secret +twoFactor.recoveryCodes +twoFactor.lastUsedTimeStep'
  );

  if (!user) {
    throw new HttpError(404, 'Utilisateur non trouvé');
  }

  if (!isTwoFactorEnabled(user)) {
    throw new HttpError(409, 'La double authentification n\'est pas activée sur ce compte.');
  }

  const isPasswordValid = await user.comparePassword(password);
  if (!isPasswordValid) {
    throw new HttpError(401, 'Mot de passe incorrect.');
  }

  await verifyTwoFactorCode(userId, code);

  // Rechargement : verifyTwoFactorCode a pu écrire sur le document.
  const refreshed = await loadUserWithTwoFactor(userId);
  refreshed.twoFactor = {
    enabled: false,
    secret: undefined,
    pendingSecret: undefined,
    recoveryCodes: undefined,
    lastUsedTimeStep: undefined,
    enabledAt: undefined
  };
  await refreshed.save();

  logger.warn('2FA désactivée', { userId: userId.substring(0, 5) + '...' });
}

/** Régénère les codes de secours, en invalidant les précédents. */
export async function regenerateRecoveryCodes(
  userId: string,
  code: string
): Promise<{ recoveryCodes: string[] }> {
  await verifyTwoFactorCode(userId, code);

  const user = await loadUserWithTwoFactor(userId);
  const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);

  user.twoFactor!.recoveryCodes = recoveryCodes.map(hashRecoveryCode);
  await user.save();

  logger.info('Codes de secours 2FA régénérés', { userId: userId.substring(0, 5) + '...' });

  return { recoveryCodes };
}

/** État de la 2FA, destiné à l'affichage dans les paramètres du compte. */
export async function getTwoFactorStatus(userId: string): Promise<{
  enabled: boolean;
  enabledAt: Date | null;
  remainingRecoveryCodes: number;
  activationPending: boolean;
}> {
  const user = await loadUserWithTwoFactor(userId);

  return {
    enabled: isTwoFactorEnabled(user),
    enabledAt: user.twoFactor?.enabledAt ?? null,
    remainingRecoveryCodes: user.twoFactor?.recoveryCodes?.length ?? 0,
    activationPending: Boolean(user.twoFactor?.pendingSecret && !user.twoFactor?.enabled)
  };
}

/**
 * Jeton intermédiaire émis après validation du mot de passe, quand la 2FA est
 * active. Il ne donne accès à rien : seul `POST /auth/2fa/verify` l'accepte.
 */
export const TWO_FACTOR_TOKEN_PURPOSE = 'two_factor_challenge';

/** Durée de vie du défi 2FA. Assez pour ouvrir son téléphone, pas plus. */
export const TWO_FACTOR_TOKEN_EXPIRES_IN = '5m';
