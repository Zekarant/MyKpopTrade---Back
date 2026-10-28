/** Message affiché quand un mot de passe ne respecte pas `validatePassword`. */
export const PASSWORD_RULES_MESSAGE =
  'Le mot de passe doit contenir au moins 8 caractères dont une majuscule, une minuscule, un chiffre et un caractère spécial';

/**
 * Chaîne non vide. Les champs passés à une requête Mongo doivent être des
 * chaînes : un tableau ou un objet deviendrait un opérateur (`$in`, `$ne`…).
 */
export const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value !== '';
