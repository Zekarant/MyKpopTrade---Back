import { Request, Response, NextFunction } from 'express';
import { RateLimiterMongo } from 'rate-limiter-flexible';
import mongoose from 'mongoose';
import logger from '../../../commons/utils/logger';

let cartAddLimiter: RateLimiterMongo | null = null;
let checkoutLimiterInstance: RateLimiterMongo | null = null;

function getCartAddLimiter(): RateLimiterMongo {
  if (!cartAddLimiter) {
    cartAddLimiter = new RateLimiterMongo({
      storeClient: mongoose.connection,
      keyPrefix: 'cart_add_rate_limit',
      points: 20,
      duration: 60,
      tableName: 'rate_limits',
    });
  }
  return cartAddLimiter;
}

function getCheckoutLimiter(): RateLimiterMongo {
  if (!checkoutLimiterInstance) {
    checkoutLimiterInstance = new RateLimiterMongo({
      storeClient: mongoose.connection,
      keyPrefix: 'cart_checkout_rate_limit',
      points: 3,
      duration: 300,
      tableName: 'rate_limits',
    });
  }
  return checkoutLimiterInstance;
}

export const rateLimitCartAdd = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = (req.user as any)?.id;
    if (!userId) { next(); return; }
    await getCartAddLimiter().consume(userId);
    next();
  } catch (error: any) {
    // Si c'est une erreur de connexion/init, on laisse passer
    if (error && error.remainingPoints !== undefined) {
      logger.warn('Rate limit panier dépassé', { userId: (req.user as any)?.id });
      res.status(429).json({
        success: false,
        message: 'Trop de modifications du panier. Veuillez patienter.'
      });
    } else {
      // Erreur technique (DB pas prête, etc.) → on laisse passer
      next();
    }
  }
};

export const rateLimitCheckout = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = (req.user as any)?.id;
    if (!userId) { next(); return; }
    await getCheckoutLimiter().consume(userId);
    next();
  } catch (error: any) {
    if (error && error.remainingPoints !== undefined) {
      logger.warn('Rate limit checkout dépassé', { userId: (req.user as any)?.id });
      res.status(429).json({
        success: false,
        message: 'Trop de tentatives de commande. Veuillez patienter quelques minutes.'
      });
    } else {
      next();
    }
  }
};
