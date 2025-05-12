import { Request, Response } from 'express';
import { asyncHandler } from '../../../commons/middlewares/errorMiddleware';
import User from '../../../models/userModel';
import logger from '../../../commons/utils/logger';

/**
 * Vérifie si une chaîne est un email valide
 */
function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Met à jour l'email PayPal du vendeur
 */
export const updatePayPalEmail = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  const { paypalEmail } = req.body;
  
  if (!paypalEmail || !isValidEmail(paypalEmail)) {
    return res.status(400).json({ message: 'Adresse email PayPal invalide' });
  }
  
  try {
    const user = await User.findByIdAndUpdate(
      userId,
      { paypalEmail },
      { new: true, runValidators: true }
    );
    
    if (!user) {
      return res.status(404).json({ message: 'Utilisateur non trouvé' });
    }
    
    return res.status(200).json({
      success: true,
      message: 'Email PayPal mis à jour avec succès',
      paypalEmail: user.paypalEmail
    });
  } catch (error) {
    logger.error('Erreur lors de la mise à jour de l\'email PayPal', { error, userId });
    return res.status(500).json({ 
      message: 'Erreur lors de la mise à jour de l\'email PayPal',
      error: process.env.NODE_ENV === 'development' 
        ? (error instanceof Error ? error.message : String(error)) 
        : undefined
    });
  }
});

/**
 * Récupère les informations du profil vendeur
 */
export const getSellerProfile = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as any).id;
  
  try {
    const user = await User.findById(userId).select('paypalEmail isSellerVerified sellerRating');
    
    if (!user) {
      return res.status(404).json({ message: 'Utilisateur non trouvé' });
    }
    
    return res.status(200).json({
      success: true,
      profile: {
        paypalEmail: user.paypalEmail || '',
        isSellerVerified: user.isSellerVerified || false,
        sellerRating: user.sellerRating || 0
      }
    });
  } catch (error) {
    logger.error('Erreur lors de la récupération du profil vendeur', { 
      error: error instanceof Error ? error.message : String(error),
      userId 
    });
    return res.status(500).json({ message: 'Erreur lors de la récupération du profil vendeur' });
  }
});