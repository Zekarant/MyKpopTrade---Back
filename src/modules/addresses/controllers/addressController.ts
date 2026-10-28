import { Request, Response } from 'express';
import { lookupAddress } from '../services/addressLookupService';

/**
 * Proxy vers l'API gouvernementale Base Adresse Nationale.
 * @route GET /api/addresses/lookup
 * @access Private
 *
 * Query params : q, postalCode, city, limit (≤ 15).
 */
export const addressLookup = async (req: Request, res: Response) => {
  const results = await lookupAddress({
    q: req.query.q,
    postalCode: req.query.postalCode,
    city: req.query.city,
    limit: req.query.limit
  });

  res.status(200).json({ success: true, results });
};
