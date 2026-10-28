import { Request, Response } from 'express';
import { badRequest } from '../../../commons/utils/httpError';
import { validateSavedSearchCreate, validateSavedSearchUpdate } from '../services/savedSearchValidationService';
import {
  listSavedSearches,
  createSavedSearch,
  updateSavedSearch,
  deleteSavedSearch
} from '../services/savedSearchService';

const VALIDATION_ERROR_CODE = 'VALIDATION_ERROR';

export const getSavedSearches = async (req: Request, res: Response) => {
  const savedSearches = await listSavedSearches(req.user!.id);
  res.status(200).json({ savedSearches });
};

export const postSavedSearch = async (req: Request, res: Response) => {
  const { value, error } = validateSavedSearchCreate(req.body);
  if (error !== undefined) throw badRequest(error, VALIDATION_ERROR_CODE);

  const savedSearch = await createSavedSearch(req.user!.id, value);
  res.location(`/api/saved-searches/${savedSearch._id}`).status(201).json({ savedSearch });
};

export const patchSavedSearch = async (req: Request, res: Response) => {
  const { value, error } = validateSavedSearchUpdate(req.body);
  if (error !== undefined) throw badRequest(error, VALIDATION_ERROR_CODE);

  const savedSearch = await updateSavedSearch(req.user!.id, String(req.params.id), value);
  res.status(200).json({ savedSearch });
};

export const removeSavedSearch = async (req: Request, res: Response) => {
  await deleteSavedSearch(req.user!.id, String(req.params.id));
  res.status(204).end();
};
