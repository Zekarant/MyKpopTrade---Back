import { mapHttpError } from '../httpErrorMapper';
import { HttpError } from '../httpError';
import type { Response } from 'express';

function createResMock(): Response & { _status?: number; _body?: unknown } {
  const res: any = {};
  res.status = jest.fn((code: number) => {
    res._status = code;
    return res;
  });
  res.json = jest.fn((body: unknown) => {
    res._body = body;
    return res;
  });
  return res;
}

describe('mapHttpError', () => {
  it('retourne une réponse avec statusCode + message quand l\'erreur est HttpError', () => {
    const res = createResMock();
    const error = new HttpError(404, 'Not found');

    const result = mapHttpError(res, error);

    expect(result).toBe(res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ message: 'Not found' });
  });

  it('retourne null pour une Error standard', () => {
    const res = createResMock();
    const error = new Error('Generic error');

    const result = mapHttpError(res, error);

    expect(result).toBeNull();
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('retourne null pour une valeur non-Error', () => {
    const res = createResMock();

    expect(mapHttpError(res, 'string error')).toBeNull();
    expect(mapHttpError(res, null)).toBeNull();
    expect(mapHttpError(res, undefined)).toBeNull();
    expect(mapHttpError(res, { statusCode: 404, message: 'fake' })).toBeNull();
  });

  it('propage le bon statusCode (403, 400, 409, ...)', () => {
    const cases = [400, 401, 403, 404, 409, 500];
    for (const code of cases) {
      const res = createResMock();
      mapHttpError(res, new HttpError(code, `code ${code}`));
      expect(res.status).toHaveBeenCalledWith(code);
    }
  });
});
