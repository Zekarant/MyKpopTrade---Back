import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger';

// Interface pour les erreurs avec des codes personnalisés
export interface AppError extends Error {
  statusCode?: number;
  code?: string;
}

/**
 * Middleware pour gérer les erreurs inconnues
 */
export const errorHandler = (
  err: AppError,
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const statusCode = err.statusCode || 500;
  const message = err.message || 'Erreur interne du serveur';
  
  // Journaliser l'erreur
  logger.error(`[${req.method}] ${req.path} - ${statusCode}: ${message}`, {
    error: err.stack,
    body: req.body,
    params: req.params,
    query: req.query,
    user: (req.user as any)?.id || 'non authentifié'
  });
  
  res.status(statusCode).json({
    error: {
      message,
      code: err.code || 'INTERNAL_SERVER_ERROR'
    }
  });
};

/**
 * Middleware pour gérer les routes non trouvées
 */
export const notFoundHandler = (req: Request, res: Response): void => {
  logger.warn(`Route non trouvée: [${req.method}] ${req.path}`);
  
  res.status(404).json({
    error: {
      message: 'Route non trouvée',
      code: 'NOT_FOUND'
    }
  });
};

/**
 * Wrapper pour gérer les erreurs dans les contrôleurs asynchrones
 */
export const asyncHandler = (fn: Function) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};