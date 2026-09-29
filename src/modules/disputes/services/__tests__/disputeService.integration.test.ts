import mongoose from 'mongoose';
import {
  startInMemoryMongo,
  stopInMemoryMongo,
  clearAllCollections
} from '../../../../tests/helpers/mongoMemory';
import { createTestUser } from '../../../../tests/helpers/fixtures';
import Dispute from '../../../../models/disputeModel';

const processRefund = jest.fn();
jest.mock('../../../payments/services/paymentService', () => ({
  processRefund: (...args: unknown[]) => processRefund(...args)
}));

import { resolveDispute } from '../disputeService';

/**
 * Arbitrage d'un litige : un seul verdict, donc un seul remboursement, même
 * quand deux admins tranchent en même temps.
 */
describe('resolveDispute (integration)', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
  }, 60000);

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  beforeEach(async () => {
    await clearAllCollections();
    processRefund.mockReset();
  });

  async function openDisputeFixture() {
    const buyer = await createTestUser();
    const seller = await createTestUser();
    const admin = await createTestUser({ role: 'admin' });
    const dispute = await Dispute.create({
      payment: new mongoose.Types.ObjectId(),
      buyer: buyer._id,
      seller: seller._id,
      openedBy: buyer._id,
      openedByRole: 'buyer',
      reason: 'not_received',
      description: 'Colis jamais reçu',
      status: 'under_review'
    });
    return { dispute, adminId: admin._id.toString() };
  }

  it('rembourse et clôture le litige', async () => {
    const { dispute, adminId } = await openDisputeFixture();
    processRefund.mockResolvedValue({});

    const resolved = await resolveDispute({ adminId, disputeId: String(dispute._id), outcome: 'refunded', refundAmount: '12.5' });

    expect(resolved.status).toBe('refunded');
    expect(resolved.resolution).toMatchObject({ outcome: 'refunded', refundAmount: 12.5 });
    expect(processRefund).toHaveBeenCalledTimes(1);
    expect(processRefund).toHaveBeenCalledWith(expect.objectContaining({ amount: 12.5 }));
  });

  it('ne rembourse qu\'une fois quand deux admins tranchent en même temps', async () => {
    const { dispute, adminId } = await openDisputeFixture();
    processRefund.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 20)));

    const outcomes = await Promise.allSettled([
      resolveDispute({ adminId, disputeId: String(dispute._id), outcome: 'refunded' }),
      resolveDispute({ adminId, disputeId: String(dispute._id), outcome: 'refunded' })
    ]);

    expect(processRefund).toHaveBeenCalledTimes(1);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find((o) => o.status === 'rejected')).toMatchObject({ reason: { code: 'DISPUTE_CLOSED' } });
  });

  it('rouvre le litige si le remboursement échoue', async () => {
    const { dispute, adminId } = await openDisputeFixture();
    processRefund.mockRejectedValue(new Error('PayPal indisponible'));

    await expect(
      resolveDispute({ adminId, disputeId: String(dispute._id), outcome: 'refunded' })
    ).rejects.toThrow('PayPal indisponible');

    const reopened = await Dispute.findById(dispute._id);
    expect(reopened!.status).toBe('under_review');
    expect(reopened!.resolution).toBeUndefined();
    expect(reopened!.closedAt).toBeUndefined();
  });

  it('clôture sans remboursement un litige rejeté', async () => {
    const { dispute, adminId } = await openDisputeFixture();

    const resolved = await resolveDispute({ adminId, disputeId: String(dispute._id), outcome: 'rejected', notes: 'Pas de preuve' });

    expect(resolved.status).toBe('rejected');
    expect(processRefund).not.toHaveBeenCalled();
  });
});
