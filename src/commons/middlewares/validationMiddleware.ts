import { Request, Response, NextFunction } from 'express';
import { badRequest } from '../utils/httpError';

/**
 * Valide la demande de remboursement : montant positif s'il est donné
 * (remboursement partiel), raison de 255 caractères au plus. L'erreur suit le
 * format commun (errorMiddleware) : `{ message, code, errors }`.
 */
export const validateRefundRequest = (req: Request, _res: Response, next: NextFunction): void => {
  const { amount, reason } = req.body;
  const errors: string[] = [];

  if (amount !== undefined && amount !== null) {
    const numAmount = parseFloat(amount);
    if (isNaN(numAmount)) {
      errors.push('Le montant doit être un nombre');
    } else if (numAmount <= 0) {
      errors.push('Le montant du remboursement doit être positif');
    }
  }

  if (reason && reason.length > 255) {
    errors.push('La raison du remboursement ne peut pas dépasser 255 caractères');
  }

  if (errors.length > 0) {
    throw badRequest('Erreur de validation des données de remboursement', 'REFUND_INVALID', { errors });
  }
  next();
};

/**
 * Exige le mot de passe actuel dans le corps, pour confirmer une action
 * sensible ; sa vérification revient au contrôleur. Ne juge pas la force d'un
 * nouveau mot de passe : c'est `validatePassword` (commons/utils/validators).
 */
export const requireConfirmationPassword = (req: Request, _res: Response, next: NextFunction): void => {
  const { password } = req.body;
  if (typeof password !== 'string' || password.length === 0) {
    throw badRequest('Le mot de passe est requis pour cette action', 'PASSWORD_REQUIRED');
  }
  next();
};
