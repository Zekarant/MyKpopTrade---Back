import { Types } from 'mongoose';
import type { IProduct } from '../../../../models/productModel';
import { resolveBuyerPrice } from '../buyerPrice';

type Negotiation = NonNullable<IProduct['negotiations']>[number];

const buyerId = new Types.ObjectId();
const otherBuyerId = new Types.ObjectId();

function negotiation(overrides: Partial<Negotiation>): Negotiation {
  return {
    buyer: buyerId,
    initialOffer: 12,
    currentOffer: 12,
    status: 'pending',
    conversationId: new Types.ObjectId(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides
  };
}

describe('resolveBuyerPrice', () => {
  it('renvoie le prix catalogue sans négociation', () => {
    expect(resolveBuyerPrice({ price: 20 }, buyerId.toString())).toBe(20);
    expect(resolveBuyerPrice({ price: 20, negotiations: [] }, buyerId.toString())).toBe(20);
    expect(resolveBuyerPrice({ price: 20, negotiations: null }, buyerId.toString())).toBe(20);
  });

  it('renvoie le montant de la négociation acceptée de cet acheteur', () => {
    const product = { price: 20, negotiations: [negotiation({ status: 'accepted', currentOffer: 15, counterOffer: 17 })] };

    expect(resolveBuyerPrice(product, buyerId.toString())).toBe(15);
  });

  it('ignore les négociations non acceptées', () => {
    const product = {
      price: 20,
      negotiations: (['pending', 'rejected', 'expired', 'completed'] as const).map((status) =>
        negotiation({ status, currentOffer: 10 })
      )
    };

    expect(resolveBuyerPrice(product, buyerId.toString())).toBe(20);
  });

  it('ignore la négociation acceptée d\'un autre acheteur', () => {
    const product = { price: 20, negotiations: [negotiation({ buyer: otherBuyerId, status: 'accepted', currentOffer: 9 })] };

    expect(resolveBuyerPrice(product, buyerId.toString())).toBe(20);
  });
});
