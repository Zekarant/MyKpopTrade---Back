/**
 * Valide un email
 */
export const validateEmail = (email: string): boolean => {
  const re = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  return re.test(email);
};

/**
 * Normalise un numéro de téléphone au format E.164 (`+33612345678`), le seul
 * que Twilio accepte. Tolère les saisies courantes : espaces, points, tirets,
 * parenthèses, préfixe `00`, et numéro national français `06 12 34 56 78`.
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