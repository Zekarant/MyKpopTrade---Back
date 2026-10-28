import { Request, Response } from 'express';
import {
  anonymizeExpiredPaymentsByAdmin,
  anonymizeOwnPayments,
  exportUserPayments
} from '../services/paymentGdprService';

/**
 * Exporte les données de paiement d'un utilisateur (droit à la portabilité)
 * @route GET /api/payments/export
 * @access Private
 */
export const exportPaymentData = async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const data = await exportUserPayments(userId);

  // Envoyer les données sous forme de fichier JSON téléchargeable
  res.setHeader('Content-Disposition', `attachment; filename=mykpoptrade_payments_export_${Date.now()}.json`);
  res.setHeader('Content-Type', 'application/json');
  res.status(200).json({
    data,
    exported_at: new Date().toISOString(),
    user_id: userId
  });
};

/**
 * Anonymise les données personnelles d'un utilisateur dans les paiements
 * @route POST /api/payments/gdpr/anonymize
 * @access Private
 */
export const anonymizeUserPaymentData = async (req: Request, res: Response) => {
  const count = await anonymizeOwnPayments(req.user!.id, req.body.password);

  res.status(200).json({
    success: true,
    message: `${count} paiements ont été anonymisés conformément à votre demande.`
  });
};

/**
 * Anonymise les données de paiement anciennes (conservation limitée dans le temps).
 * @route POST /api/payments/gdpr/anonymize-old-payments
 * @access Admin (requireAdmin)
 */
export const anonymizeOldPayments = async (req: Request, res: Response) => {
  const count = await anonymizeExpiredPaymentsByAdmin(req.user!.id);

  res.status(200).json({
    success: true,
    message: `${count} paiements ont été anonymisés conformément à la politique de conservation des données.`
  });
};
