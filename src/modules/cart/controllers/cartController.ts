import { Request, Response, NextFunction } from 'express';
import * as cartService from '../services/cartService';

export async function getCart(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id;
    const cart = await cartService.getCart(userId);
    res.json({ success: true, cart });
  } catch (error) {
    next(error);
  }
}

export async function addItem(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id;
    const { productId } = req.body;
    if (!productId) {
      res.status(400).json({ success: false, message: 'productId requis' });
      return;
    }
    const cart = await cartService.addItem(userId, productId);
    res.json({ success: true, cart });
  } catch (error) {
    next(error);
  }
}

export async function removeItem(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id;
    const productId = req.params.productId as string;
    const cart = await cartService.removeItem(userId, productId);
    res.json({ success: true, cart });
  } catch (error) {
    next(error);
  }
}

export async function clearCart(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id;
    await cartService.clearCart(userId);
    res.json({ success: true, message: 'Panier vidé' });
  } catch (error) {
    next(error);
  }
}

export async function validateCart(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id;
    const result = await cartService.validateCart(userId);
    res.json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
}
