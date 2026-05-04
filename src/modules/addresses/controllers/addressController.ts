import { Request, Response } from 'express';
import { asyncHandler } from '../../../commons/middlewares/errorMiddleware';
import { lookupAddress } from '../services/addressLookupService';
import { HttpError } from '../../../commons/utils/httpError';
import logger from '../../../commons/utils/logger';

/**
 * Proxy vers l'API gouvernementale Base Adresse Nationale.
 * @route GET /api/addresses/lookup
 * @access Private
 *
 * Query params : q, postalCode, city, limit (≤ 15).
 */
export const addressLookup = asyncHandler(async (req: Request, res: Response) => {
  try {
    const results = await lookupAddress({
      q: req.query.q,
      postalCode: req.query.postalCode,
      city: req.query.city,
      limit: req.query.limit
    });

    return res.status(200).json({ success: true, results });
  } catch (error) {
    if (error instanceof HttpError) {
      return res.status(error.statusCode).json({
        success: false,
        message: error.message
      });
    }
    logger.error('Erreur lors du lookup d\'adresse', {
      error: error instanceof Error ? error.message : String(error)
    });
    return res.status(500).json({
      success: false,
      message: 'Une erreur est survenue lors du lookup d\'adresse'
    });
  }
});
