jest.mock('../../services/paymentService');

import { Request, Response } from 'express';
import { capturePayPalPayment } from '../paymentController';
import { captureDirectPayment } from '../../services/paymentService';
import { HttpError } from '../../../../commons/utils/httpError';

function fakeResponse() {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

async function callCapture(res: ReturnType<typeof fakeResponse>) {
  const req = { user: { id: 'buyer-1' }, body: { orderId: 'ORDER-1' } } as unknown as Request;
  capturePayPalPayment(req, res as unknown as Response, jest.fn());
  // asyncHandler ne renvoie pas la promesse : on laisse la micro-tâche se terminer.
  await new Promise((resolve) => setImmediate(resolve));
}

describe('POST /payments/paypal/capture', () => {
  it('renvoie 400 avec le code ORDER_NOT_APPROVED et l\'URL d\'approbation au premier niveau', async () => {
    const notApproved = new HttpError(400, 'Le paiement n\'a pas encore été approuvé sur PayPal', 'ORDER_NOT_APPROVED');
    notApproved.details = { approvalUrl: 'https://paypal.test/approve' };
    jest.mocked(captureDirectPayment).mockRejectedValue(notApproved);
    const res = fakeResponse();

    await callCapture(res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      message: 'Le paiement n\'a pas encore été approuvé sur PayPal',
      code: 'ORDER_NOT_APPROVED',
      approvalUrl: 'https://paypal.test/approve'
    });
  });
});
