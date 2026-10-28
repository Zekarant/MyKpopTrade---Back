import { Request, Response } from 'express';
import * as cartCheckoutService from '../services/cartCheckoutService';
import { badRequest } from '../../../commons/utils/httpError';

const VALID_SHIPPING_METHODS = ['national', 'worldwide', 'localPickup'] as const;

export async function checkoutCart(req: Request, res: Response) {
  const { shippingMethod, shippingAddress } = req.body;

  if (!shippingMethod || !VALID_SHIPPING_METHODS.includes(shippingMethod)) {
    throw badRequest('shippingMethod invalide (national, worldwide, localPickup)');
  }

  // Valider l'adresse si nécessaire
  if (shippingMethod !== 'localPickup') {
    if (!shippingAddress || !shippingAddress.recipientName || !shippingAddress.streetLine1 || !shippingAddress.postalCode || !shippingAddress.city) {
      throw badRequest('Adresse de livraison incomplète');
    }
  }

  const results = await cartCheckoutService.checkoutCart(req.user!.id, {
    shippingMethod,
    shippingAddress: shippingMethod !== 'localPickup' ? shippingAddress : undefined
  });

  res.json({ success: true, payments: results });
}

export async function finalizeCheckout(req: Request, res: Response) {
  await cartCheckoutService.finalizeCartCheckout(req.user!.id);
  res.json({ success: true, message: 'Panier vidé après checkout' });
}
