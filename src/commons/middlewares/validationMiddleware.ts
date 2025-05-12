import { Request, Response, NextFunction } from 'express';

/**
 * Valide la requête de remboursement
 */
export const validateRefundRequest = (req: Request, res: Response, next: NextFunction): void => {
  const { amount, reason } = req.body;
  const errors: string[] = [];
  
  // Valider le montant si présent (remboursement partiel)
  if (amount !== undefined && amount !== null) {
    // Vérifier que c'est un nombre
    if (isNaN(parseFloat(amount))) {
      errors.push('Le montant doit être un nombre');
    } else {
      const numAmount = parseFloat(amount);
      // Vérifier que c'est positif
      if (numAmount <= 0) {
        errors.push('Le montant du remboursement doit être positif');
      }
      // Vérifier qu'il n'a pas trop de décimales
      // if (numAmount.toFixed(2) !== String(numAmount)) {
      //   errors.push('Le montant ne peut pas avoir plus de 2 décimales');
      // }
    }
  }
  
  // Valider la raison
  if (reason && reason.length > 255) {
    errors.push('La raison du remboursement ne peut pas dépasser 255 caractères');
  }
  
  if (errors.length > 0) {
    res.status(400).json({
      success: false,
      errors,
      message: 'Erreur de validation des données de remboursement'
    });
    return; // Important: on retourne sans appeler next()
  }
  
  next(); // Si tout est valide, on passe à la suite
};