import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { errorHandler, notFoundHandler } from '../errorMiddleware';
import { requestIdMiddleware } from '../requestIdMiddleware';
import { HttpError } from '../../utils/httpError';

/** Format unique des erreurs : `{ message, code?, ...details, requestId? }`. */
function appThrowing(error: unknown) {
  const app = express();
  app.use(requestIdMiddleware);
  app.use(express.json());
  app.post('/boom', (_req: Request, _res: Response, next: NextFunction) => next(error));
  // Express 5 transmet la promesse rejetée d'un handler asynchrone.
  app.get('/async', async () => {
    throw error;
  });
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

describe('errorHandler', () => {
  it('renvoie une HttpError à plat, avec son code et ses détails', async () => {
    const error = new HttpError(400, 'Commande non approuvée', 'ORDER_NOT_APPROVED', { approvalUrl: 'https://paypal.test' });

    const res = await request(appThrowing(error)).get('/async');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: 'Commande non approuvée', code: 'ORDER_NOT_APPROVED', approvalUrl: 'https://paypal.test' });
  });

  it('traduit une erreur de validation Mongoose en 400', async () => {
    const error = new mongoose.Error.ValidationError();
    error.addError('email', new mongoose.Error.ValidatorError({ path: 'email', message: 'invalide' }));

    const res = await request(appThrowing(error)).get('/async');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('garde le 400 d\'un JSON malformé au lieu d\'en faire un 500', async () => {
    const res = await request(appThrowing(new Error('jamais levée')))
      .post('/boom')
      .set('Content-Type', 'application/json')
      .send('{"pas du json"');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BAD_REQUEST');
  });

  it('répond 500 avec un requestId sur une erreur inattendue', async () => {
    const res = await request(appThrowing(new Error('connexion Mongo perdue'))).get('/async');

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_SERVER_ERROR');
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
  });

  it('renvoie une 404 au même format pour une route inconnue', async () => {
    const res = await request(appThrowing(null)).get('/inconnue');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ message: 'Route non trouvée', code: 'NOT_FOUND' });
  });
});
