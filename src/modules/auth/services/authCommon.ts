import { HttpError } from '../../../commons/utils/httpError';

/** Refus d'ouvrir une session sur un compte suspendu (mot de passe, 2FA, OAuth). */
export const accountSuspendedError = () =>
  new HttpError(403, 'Votre compte est suspendu. Contactez le support.', 'ACCOUNT_SUSPENDED');

/** Identifiant tronqué pour les journaux : assez pour corréler, pas pour identifier. */
export const maskUserId = (userId: string) => `${userId.substring(0, 5)}...`;
