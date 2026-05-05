import { Request, Response, NextFunction } from 'express';
import * as cartCheckoutService from '../services/cartCheckoutService';

const VALID_SHIPPING_METHODS = ['national', 'worldwide', 'localPickup'] as const;

export async function checkoutCart(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = (req.user as any).id;
    const { shippingMethod, shippingAddress } = req.body;

    if (!shippingMethod || !VALID_SHIPPING_METHODS.includes(shippingMethod)) {
      res.status(400).json({ success: false, message: 'shippingMethod invalide (national, worldwide, localPickup)' });
      return;
    }

    // Valider l'adresse si nécessaire
    if (shippingMethod !== 'localPickup') {
      if (!shippingAddress || !shippingAddress.recipientName || !shippingAddress.streetLine1 || !shippingAddress.postalCode || !shippingAddress.city) {
        res.status(400).json({ success: false, message: 'Adresse de livraison incomplète' });
        return;
      }
    }

    const results = await cartCheckoutService.checkoutCart(userId, {
      shippingMethod,
      shippingAddress: shippingMethod !== 'localPickup' ? shippingAddress : undefined
    });

    res.json({ success: true, payments: results });
  } catch (error) {
    next(error);
  }
}

export async function finalizeCheckout(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = (req.user as any).id;
    await cartCheckoutService.finalizeCartCheckout(userId);
    res.json({ success: true, message: 'Panier vidé après checkout' });
  } catch (error) {
    next(error);
  }
}
