jest.mock('../../services/paymentService');

import { Request, Response } from 'express';
import { capturePayPalPayment } from '../paymentController';
import { captureDirectPayment } from '../../services/paymentService';
import { HttpError } from '../../../../commons/utils/httpError';
import { errorHandler } from '../../../../commons/middlewares/errorMiddleware';

function fakeResponse() {
  const res = { status: jest.fn(), json: jest.fn(), get: jest.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

describe('POST /payments/paypal/capture', () => {
  it('renvoie 400 avec le code ORDER_NOT_APPROVED et l\'URL d\'approbation au premier niveau', async () => {
    const notApproved = new HttpError(400, 'Le paiement n\'a pas encore été approuvé sur PayPal', 'ORDER_NOT_APPROVED');
    notApproved.details = { approvalUrl: 'https://paypal.test/approve' };
    jest.mocked(captureDirectPayment).mockRejectedValue(notApproved);
    const req = { method: 'POST', path: '/paypal/capture', user: { id: 'buyer-1' }, body: { orderId: 'ORDER-1' } } as unknown as Request;
    const res = fakeResponse();

    // Express 5 transmet la promesse rejetée au gestionnaire d'erreurs central.
    const error = await capturePayPalPayment(req, res as unknown as Response).catch((e: unknown) => e);
    errorHandler(error, req, res as unknown as Response, jest.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      message: 'Le paiement n\'a pas encore été approuvé sur PayPal',
      code: 'ORDER_NOT_APPROVED',
      approvalUrl: 'https://paypal.test/approve'
    });
  });
});
