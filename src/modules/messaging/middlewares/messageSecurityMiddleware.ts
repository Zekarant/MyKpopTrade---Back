import { Request, Response, NextFunction } from 'express';
import { RateLimiterMongo } from 'rate-limiter-flexible';
import mongoose from 'mongoose';
import logger from '../../../commons/utils/logger';

// Stocker les erreurs de limitation par utilisateur avec un timestamp
const userRateLimitErrors = new Map<string, number>();

// Configuration du limiteur de débit
const messageLimiter = new RateLimiterMongo({
  storeClient: mongoose.connection,
  keyPrefix: 'messaging_rate_limit',
  points: 10, // nombre de messages autorisés
  duration: 60, // par minute
});

/**
 * Middleware pour limiter le nombre de messages (anti-spam)
 */
export const rateLimitMessages = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = (req.user as any).id;
    
    // Vérifier s'il y a eu une erreur récente pour cet utilisateur
    const lastErrorTime = userRateLimitErrors.get(userId);
    const currentTime = Date.now();
    
    if (lastErrorTime && (currentTime - lastErrorTime) < 60000) {
      // L'utilisateur a récemment dépassé sa limite, attendre encore un peu
      const remainingSeconds = Math.ceil((60000 - (currentTime - lastErrorTime)) / 1000);
      
      res.status(429).json({ 
        message: `Vous avez dépassé la limite de messages. Veuillez réessayer dans ${remainingSeconds} secondes.` 
      });
      return;
    }
    
    await messageLimiter.consume(userId);
    // Si on arrive ici, la limite n'est pas dépassée
    next();
  } catch (error) {
    const userId = (req.user as any).id;
    // Enregistrer le timestamp de l'erreur
    userRateLimitErrors.set(userId, Date.now());
    
    logger.warn(`Limite de messages dépassée par l'utilisateur ${userId}`);
    res.status(429).json({ 
      message: 'Vous envoyez trop de messages. Veuillez attendre une minute avant d\'en envoyer d\'autres.' 
    });
  }
};