import mongoose from 'mongoose';
import { HttpError, assertOwner, userNotFound } from '../httpError';

describe('userNotFound', () => {
  it('même 404, même message et même code partout', () => {
    expect(userNotFound()).toMatchObject({ statusCode: 404, message: 'Utilisateur non trouvé', code: 'USER_NOT_FOUND' });
  });
});

describe('assertOwner', () => {
  const userId = new mongoose.Types.ObjectId().toString();

  it('laisse passer le propriétaire, que l\'identifiant soit un ObjectId ou une chaîne', () => {
    expect(() => assertOwner(new mongoose.Types.ObjectId(userId), userId)).not.toThrow();
    expect(() => assertOwner(userId, userId)).not.toThrow();
  });

  it('refuse (403) un autre utilisateur, avec le message et le code fournis', () => {
    const other = new mongoose.Types.ObjectId();
    let error: unknown;
    try {
      assertOwner(other, userId, 'Seul le vendeur peut effectuer cette action', 'SHIPMENT_FORBIDDEN');
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({
      statusCode: 403,
      message: 'Seul le vendeur peut effectuer cette action',
      code: 'SHIPMENT_FORBIDDEN'
    });
  });

  it('applique le message et le code par défaut de forbidden', () => {
    expect(() => assertOwner('autre', userId)).toThrow(expect.objectContaining({ statusCode: 403, code: 'FORBIDDEN' }));
  });
});

describe('HttpError', () => {
  it('stocke le statusCode et le message', () => {
    const error = new HttpError(404, 'Not found');
    expect(error.statusCode).toBe(404);
    expect(error.message).toBe('Not found');
  });

  it('est une instance de Error (chainage natif)', () => {
    const error = new HttpError(400, 'Bad request');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(HttpError);
  });

  it('expose le message via error.message pour l\'API Error standard', () => {
    const error = new HttpError(500, 'Server error');
    expect(error.message).toBe('Server error');
  });

  it('supporte différents codes HTTP', () => {
    const cases: Array<[number, string]> = [
      [400, 'Bad request'],
      [401, 'Unauthorized'],
      [403, 'Forbidden'],
      [404, 'Not found'],
      [409, 'Conflict'],
      [500, 'Internal server error']
    ];

    for (const [code, msg] of cases) {
      const error = new HttpError(code, msg);
      expect(error.statusCode).toBe(code);
      expect(error.message).toBe(msg);
    }
  });
});
