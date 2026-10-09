/** Longueur maximale d'une adresse email (RFC 5321). */
const EMAIL_MAX_LENGTH = 254;

const EMAIL_PATTERN = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

/**
 * Valide un email
 *
 * La longueur est bornée avant la regex : son coût, quadratique sur le domaine,
 * reste ainsi négligeable quelle que soit la taille du corps de requête.
 */
export const validateEmail = (email: string): boolean =>
  typeof email === 'string' && email.length <= EMAIL_MAX_LENGTH && EMAIL_PATTERN.test(email);

/**
 * Normalise un numéro de téléphone au format E.164, le seul que Twilio accepte.
 * Tolère espaces, points, tirets, parenthèses, préfixe `00` et numéro national français.
 * @returns le numéro E.164, ou `null` s'il est invalide
 */
export const normalizePhoneNumber = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null;
  let phone = raw.replace(/[\s.\-()]/g, '');
  if (phone.startsWith('00')) {
    phone = `+${phone.slice(2)}`;
  } else if (/^0[1-9]\d{8}$/.test(phone)) {
    phone = `+33${phone.slice(1)}`;
  }
  return /^\+[1-9]\d{7,14}$/.test(phone) ? phone : null;
};

/**
 * Valide un mot de passe
 * Au moins 8 caractères, une majuscule, une minuscule, un chiffre et un caractère spécial
 */
export const validatePassword = (password: string): boolean => {
  if (password.length < 8) return false;
  
  const hasUppercase = /[A-Z]/.test(password);
  const hasLowercase = /[a-z]/.test(password);
  const hasNumber = /[0-9]/.test(password);
  const hasSpecial = /[!@#$%^&*(),.?":{}|<>]/.test(password);
  
  return hasUppercase && hasLowercase && hasNumber && hasSpecial;
};

/**
 * Valide un nom d'utilisateur
 * Entre 3 et 30 caractères, lettres, chiffres, underscore et tiret
 */
export const validateUsername = (username: string): boolean => {
  const re = /^[a-zA-Z0-9_-]{3,30}$/;
  return re.test(username);
};