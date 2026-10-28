import { asHttpError } from '../httpErrorMapper';
import { HttpError } from '../httpError';
import mongoose from 'mongoose';

describe('asHttpError', () => {
  it('rend telle quelle une HttpError, code métier compris', () => {
    const error = new HttpError(403, 'Bloqué', 'BLOCKED');

    expect(asHttpError(error)).toBe(error);
  });

  it('ne traduit pas une vraie erreur serveur (500 par le gestionnaire central)', () => {
    expect(asHttpError(new Error('Generic error'))).toBeNull();
    expect(asHttpError('string error')).toBeNull();
    expect(asHttpError(null)).toBeNull();
    expect(asHttpError(undefined)).toBeNull();
    expect(asHttpError({ statusCode: 404, message: 'fake' })).toBeNull();
  });

  it('traduit les erreurs de données Mongoose en erreurs client', () => {
    const validation = new mongoose.Error.ValidationError();
    validation.addError('albumType', new mongoose.Error.ValidatorError({ path: 'albumType', message: 'invalide' }));
    const cases: Array<[unknown, number, string]> = [
      [validation, 400, 'VALIDATION_ERROR'],
      [new mongoose.Error.CastError('ObjectId', 'abc', 'artistId'), 400, 'INVALID_VALUE'],
      [Object.assign(new Error('E11000 duplicate key'), { code: 11000 }), 409, 'DUPLICATE']
    ];
    for (const [error, status, code] of cases) {
      expect(asHttpError(error)).toMatchObject({ statusCode: status, code });
    }
  });

  it('expose les refus 4xx de body-parser (JSON malformé, corps trop gros)', () => {
    const tooLarge = Object.assign(new Error('request entity too large'), { status: 413, expose: true });
    const hidden = Object.assign(new Error('internal'), { status: 400, expose: false });

    expect(asHttpError(tooLarge)).toMatchObject({ statusCode: 413, code: 'PAYLOAD_TOO_LARGE' });
    expect(asHttpError(hidden)).toBeNull();
  });
});
