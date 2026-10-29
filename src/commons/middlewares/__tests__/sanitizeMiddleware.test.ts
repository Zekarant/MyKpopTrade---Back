import { Request, Response } from 'express';
import { sanitizeInputs } from '../sanitizeMiddleware';

function run(req: Partial<Request>) {
  const next = jest.fn();
  sanitizeInputs(req as Request, {} as Response, next);
  return next;
}

describe('sanitizeInputs', () => {
  it.each([
    ['A&B', 'A&B'],
    ['1 < 2 & 3 > 2', '1 < 2 & 3 > 2'],
    ['I <3 BTS', 'I <3 BTS'],
    ['« guillemets » et "doubles" et \'simples\'', '« guillemets » et "doubles" et \'simples\''],
    ['<b>gras</b> conservé en texte', 'gras conservé en texte'],
    ['<img src=x onerror=alert(1)>coucou', 'coucou'],
    ['<script>alert(1)</script>ok', 'ok'],
    // Saisi sous forme d'entités, c'est du texte : il est stocké tel quel, décodé.
    // À l'affichage, le front et les e-mails l'échappent (voir shipmentReminderEmail.test).
    ['&lt;a href="x"&gt;Payer&lt;/a&gt;', '<a href="x">Payer</a>']
  ])('stocke du texte brut : %s → %s', (input, expected) => {
    const req = { body: { content: input, count: 3 } };

    const next = run(req);

    expect(req.body).toEqual({ content: expected, count: 3 });
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
