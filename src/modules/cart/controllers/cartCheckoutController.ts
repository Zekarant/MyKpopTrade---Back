import { Request, Response } from 'express';
import * as cartCheckoutService from '../services/cartCheckoutService';
import {
  SHIPPING_METHODS,
  assertShippingMethod,
  validateShippingAddress
} from '../../payments/services/checkoutService';

export async function checkoutCart(req: Request, res: Response) {
  // Mêmes règles que le paiement d'une annonce seule (checkoutService), vérifiées
  // ici une fois pour tout le panier, avant le premier appel à PayPal.
  const shippingMethod = assertShippingMethod(req.body.shippingMethod);
  const shippingAddress = shippingMethod === SHIPPING_METHODS.LOCAL_PICKUP
    ? undefined
    : validateShippingAddress(req.body.shippingAddress);

  const results = await cartCheckoutService.checkoutCart(req.user!.id, { shippingMethod, shippingAddress });

  res.json({ success: true, payments: results });
}

export async function finalizeCheckout(req: Request, res: Response) {
  await cartCheckoutService.finalizeCartCheckout(req.user!.id);
  res.json({ success: true, message: 'Panier vidé après checkout' });
}
