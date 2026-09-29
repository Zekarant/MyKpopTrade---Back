import crypto from 'crypto';
import OneTimeCode, { OneTimeCodePurpose } from '../../../models/oneTimeCodeModel';

/** Le front utilise le code dès qu'il le reçoit : une minute suffit. */
const CODE_TTL_MS = 60 * 1000;

const hashCode = (code: string) => crypto.createHash('sha256').update(code).digest('hex');

export async function issueOneTimeCode(userId: string, purpose: OneTimeCodePurpose): Promise<string> {
  const code = crypto.randomBytes(32).toString('base64url');
  await OneTimeCode.create({
    codeHash: hashCode(code),
    purpose,
    userId,
    expiresAt: new Date(Date.now() + CODE_TTL_MS)
  });
  return code;
}

/**
 * Consomme un code : il ne sert qu'une fois, même en cas de requêtes
 * simultanées (suppression atomique).
 * @returns l'utilisateur concerné, ou null si le code est inconnu, expiré,
 * déjà utilisé ou émis pour un autre usage.
 */
export async function consumeOneTimeCode(code: string, purpose: OneTimeCodePurpose): Promise<string | null> {
  const found = await OneTimeCode.findOneAndDelete({
    codeHash: hashCode(code),
    purpose,
    expiresAt: { $gt: new Date() }
  });
  return found ? found.userId.toString() : null;
}
