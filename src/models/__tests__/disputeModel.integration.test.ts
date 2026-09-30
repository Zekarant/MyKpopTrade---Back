import { Types } from 'mongoose';
import { startInMemoryMongo, stopInMemoryMongo, clearAllCollections } from '../../tests/helpers/mongoMemory';
import Dispute from '../disputeModel';

function disputeOn(payment: Types.ObjectId, status: 'opened' | 'under_review' | 'resolved') {
  const party = new Types.ObjectId();
  return {
    payment,
    buyer: party,
    seller: new Types.ObjectId(),
    openedBy: party,
    openedByRole: 'buyer' as const,
    reason: 'not_received' as const,
    description: 'Colis jamais arrivé',
    status
  };
}

describe('disputeModel (integration)', () => {
  beforeAll(async () => {
    await startInMemoryMongo();
    await Dispute.init();
  }, 60000);

  afterAll(async () => {
    await stopInMemoryMongo();
  });

  beforeEach(async () => {
    await clearAllCollections();
  });

  it('refuse un second litige actif sur le même paiement', async () => {
    const payment = new Types.ObjectId();
    await Dispute.create(disputeOn(payment, 'opened'));

    await expect(Dispute.create(disputeOn(payment, 'under_review'))).rejects.toMatchObject({ code: 11000 });
  });

  it('accepte un nouveau litige une fois le précédent clôturé', async () => {
    const payment = new Types.ObjectId();
    await Dispute.create(disputeOn(payment, 'resolved'));

    await expect(Dispute.create(disputeOn(payment, 'opened'))).resolves.toBeDefined();
  });
});
