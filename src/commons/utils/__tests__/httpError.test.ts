import { HttpError } from '../httpError';

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
