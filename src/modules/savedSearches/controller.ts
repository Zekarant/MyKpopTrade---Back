import { Request, Response } from 'express';
import { asyncHandler } from '../../commons/middlewares/errorMiddleware';
import { mapHttpError } from '../../commons/utils/httpErrorMapper';
import { HttpError } from '../../commons/utils/httpError';
import { validateSavedSearchCreate, validateSavedSearchUpdate } from './validation';
import {
  listSavedSearches,
  createSavedSearch,
  updateSavedSearch,
  deleteSavedSearch
} from './service';

type Handler = (req: Request, res: Response) => Promise<unknown>;

/**
 * Erreurs métier au format `{ message }` lu par le front ; une erreur
 * inattendue remonte au gestionnaire global (journalisée, 500).
 */
const handle = (handler: Handler) => asyncHandler(async (req: Request, res: Response) => {
  try {
    await handler(req, res);
  } catch (error) {
    if (!mapHttpError(res, error)) throw error;
  }
});

export const getSavedSearches = handle(async (req, res) => {
  const savedSearches = await listSavedSearches(req.user!.id);
  res.status(200).json({ savedSearches });
});

export const postSavedSearch = handle(async (req, res) => {
  const { value, error } = validateSavedSearchCreate(req.body);
  if (error !== undefined) throw new HttpError(400, error);

  const savedSearch = await createSavedSearch(req.user!.id, value);
  res.location(`/api/saved-searches/${savedSearch._id}`).status(201).json({ savedSearch });
});

export const patchSavedSearch = handle(async (req, res) => {
  const { value, error } = validateSavedSearchUpdate(req.body);
  if (error !== undefined) throw new HttpError(400, error);

  const savedSearch = await updateSavedSearch(req.user!.id, String(req.params.id), value);
  res.status(200).json({ savedSearch });
});

export const removeSavedSearch = handle(async (req, res) => {
  await deleteSavedSearch(req.user!.id, String(req.params.id));
  res.status(204).end();
});
