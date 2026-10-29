import express, { Request, Response } from 'express';
import request from 'supertest';
import { errorHandler } from '../errorMiddleware';
import { requireConfirmationPassword, validateRefundRequest } from '../validationMiddleware';

/** Validations d'entrée : erreurs au format commun `{ message, code, ... }` (errorMiddleware). */
function appWith(middleware: express.RequestHandler) {
  const app = express();
  app.use(express.json());
  app.post('/action', middleware, (_req: Request, res: Response) => {
    res.json({ ok: true });
  });
  app.use(errorHandler);
  return app;
}

describe('validateRefundRequest', () => {
  it('laisse passer un remboursement total ou un montant positif', async () => {
    await request(appWith(validateRefundRequest)).post('/action').send({}).expect(200);
    await request(appWith(validateRefundRequest)).post('/action').send({ amount: 12.5, reason: 'Colis abîmé' }).expect(200);
  });

  it('refuse un montant invalide et une raison trop longue, en listant les erreurs', async () => {
    const res = await request(appWith(validateRefundRequest))
      .post('/action')
      .send({ amount: -3, reason: 'x'.repeat(256) });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      message: 'Erreur de validation des données de remboursement',
      code: 'REFUND_INVALID',
      errors: [
        'Le montant du remboursement doit être positif',
        'La raison du remboursement ne peut pas dépasser 255 caractères'
      ]
    });
  });
});

describe('requireConfirmationPassword', () => {
  it('exige le mot de passe actuel, sans juger sa force', async () => {
    await request(appWith(requireConfirmationPassword)).post('/action').send({ password: 'a' }).expect(200);

    const res = await request(appWith(requireConfirmationPassword)).post('/action').send({});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ message: 'Le mot de passe est requis pour cette action', code: 'PASSWORD_REQUIRED' });
  });
});
