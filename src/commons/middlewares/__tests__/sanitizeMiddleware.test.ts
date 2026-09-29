import { Request, Response } from 'express';
import { sanitizeInputs } from '../sanitizeMiddleware';

jest.mock('isomorphic-dompurify', () => ({
  __esModule: true,
  default: { sanitize: (value: string) => `propre(${value})` }
}));

function run(req: Partial<Request>) {
  const next = jest.fn();
  sanitizeInputs(req as Request, {} as Response, next);
  return next;
}

describe('sanitizeInputs', () => {
  it('nettoie les champs texte de premier niveau du corps', () => {
    const req = { body: { content: '<img onerror=x>', count: 3 } };

    const next = run(req);

    expect(req.body).toEqual({ content: 'propre(<img onerror=x>)', count: 3 });
    expect(next).toHaveBeenCalledWith();
  });

  it('laisse les paramètres d\'URL intacts : une recherche « a<b » reste « a<b »', () => {
    const req = { body: {}, query: { q: 'a<b' } };

    run(req as Partial<Request>);

    expect(req.query).toEqual({ q: 'a<b' });
  });

  it('accepte une requête sans corps', () => {
    const next = run({});

    expect(next).toHaveBeenCalledWith();
  });
});
