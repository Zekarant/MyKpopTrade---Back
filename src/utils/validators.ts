/**
 * Valide le format d'une adresse email
 */
export const validateEmail = (email: string): boolean => {
    const re = /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
    return re.test(String(email).toLowerCase());
  };
  
  /**
   * Valide la complexité d'un mot de passe
   * - Au moins 8 caractères
   * - Au moins une lettre majuscule
   * - Au moins une lettre minuscule
   * - Au moins un chiffre
   * - Au moins un caractère spécial
   */
  export const validatePassword = (password: string): boolean => {
    const minLength = 8;
    const hasUppercase = /[A-Z]/.test(password);
    const hasLowercase = /[a-z]/.test(password);
    const hasDigit = /[0-9]/.test(password);
    const hasSpecial = /[!@#$%^&*(),.?":{}|<>]/.test(password);
  
    return (
      password.length >= minLength &&
      hasUppercase &&
      hasLowercase &&
      hasDigit &&
      hasSpecial
    );
  };
  
  /**
   * Valide un numéro de téléphone
   */
  export const validatePhoneNumber = (phoneNumber: string): boolean => {
    // Validation simple, à adapter selon le format attendu dans votre pays
    const re = /^(\+\d{1,3}[- ]?)?\d{9,10}$/;
    return re.test(phoneNumber);
  };