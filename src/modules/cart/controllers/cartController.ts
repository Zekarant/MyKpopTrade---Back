import { Request, Response } from 'express';
import * as cartService from '../services/cartService';
import { badRequest } from '../../../commons/utils/httpError';

export async function getCart(req: Request, res: Response) {
  const cart = await cartService.getCart(req.user!.id);
  res.json({ success: true, cart });
}

export async function addItem(req: Request, res: Response) {
  const { productId } = req.body;
  if (!productId) {
    throw badRequest('productId requis');
  }
  const cart = await cartService.addItem(req.user!.id, productId);
  res.json({ success: true, cart });
}

export async function removeItem(req: Request, res: Response) {
  const cart = await cartService.removeItem(req.user!.id, req.params.productId as string);
  res.json({ success: true, cart });
}

export async function clearCart(req: Request, res: Response) {
  await cartService.clearCart(req.user!.id);
  res.json({ success: true, message: 'Panier vidé' });
}

export async function validateCart(req: Request, res: Response) {
  const result = await cartService.validateCart(req.user!.id);
  res.json({ success: true, ...result });
}
