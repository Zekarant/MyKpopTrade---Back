/**
 * Valide un email
 */
export const validateEmail = (email: string): boolean => {
  const re = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  return re.test(email);
};

/**
 * Valide un numéro de téléphone au format international
 * @param phoneNumber Le numéro de téléphone à valider
 * @returns true si le numéro est valide, false sinon
 */
export const validatePhoneNumber = (phoneNumber: string): boolean => {
  // Format international E.164 ou format simplifié
  return /^\+?[1-9]\d{1,14}$/.test(phoneNumber);
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