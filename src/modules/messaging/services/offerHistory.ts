import { Types } from 'mongoose';
import Conversation from '../../../models/conversationModel';
import { IProduct } from '../../../models/productModel';
import { USER_CARD_FIELDS } from '../../../commons/utils/userFields';

/** Briques partagées par les offres, leurs réponses et le prix libre. */

export const OFFER_STATUS = {
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
  EXPIRED: 'expired'
} as const;

export type OfferStatus = typeof OFFER_STATUS[keyof typeof OFFER_STATUS];

export const OFFER_TYPE = {
  INITIAL: 'initial',
  COUNTER: 'counter'
} as const;

export const NEGOTIATION_CONVERSATION_TYPE = 'negotiation';

export type ObjectIdLike = Types.ObjectId | string;
export type NegotiatedProduct = Pick<IProduct, '_id' | 'seller' | 'title' | 'price' | 'currency'>;

export function buildOfferEntry(
  userId: string,
  amount: number,
  offerType: typeof OFFER_TYPE[keyof typeof OFFER_TYPE],
  message?: string
) {
  return {
    offeredBy: userId,
    amount,
    offerType,
    status: OFFER_STATUS.PENDING,
    message: message || '',
    createdAt: new Date()
  };
}

export async function setOfferHistoryStatus(
  conversationId: ObjectIdLike,
  offerId: Types.ObjectId,
  status: OfferStatus,
  extraSet: Record<string, unknown> = {}
): Promise<void> {
  await Conversation.updateOne(
    { _id: conversationId, 'offerHistory._id': offerId },
    { $set: { 'offerHistory.$.status': status, ...extraSet } }
  );
}

/** Conversation d'offre telle que renvoyée au front après chaque action. */
export function findOfferConversation(conversationId: ObjectIdLike) {
  return Conversation.findById(conversationId)
    .populate('participants', USER_CARD_FIELDS)
    .populate('productId', 'title price images')
    .populate('lastMessage')
    .populate('offerHistory.offeredBy', USER_CARD_FIELDS);
}
