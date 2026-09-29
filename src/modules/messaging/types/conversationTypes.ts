import { Types } from 'mongoose';
import { IOfferHistory } from '../../../models/conversationModel';
import { IProduct } from '../../../models/productModel';

/**
 * Type pour les produits dans les conversations
 */
export type LeanProduct = {
  _id: Types.ObjectId;
  title: string;
  description?: string;
  price: number;
  images: string[];
  seller: Types.ObjectId;
  category?: string;
  condition?: string;
  kpopGroup?: string;
  kpopMember?: string;
  albumName?: string;
  currency: string;
  isAvailable: boolean;
  allowOffers?: boolean;
  minOfferPercentage?: number;
  shippingOptions?: IProduct['shippingOptions'];
  createdAt: Date;
  categoryLabel?: string;
};

/**
 * Type helper pour les conversations avec lean()
 */
export type LeanConversation = {
  _id: Types.ObjectId;
  participants: Types.ObjectId[];
  productId?: LeanProduct;
  lastMessage?: Types.ObjectId;
  lastMessageAt: Date;
  isActive: boolean;
  type: 'general' | 'product_inquiry' | 'negotiation' | 'pay_what_you_want';
  status: 'open' | 'closed' | 'archived';
  createdBy: Types.ObjectId;
  title?: string;
  deletedBy: Types.ObjectId[];
  archivedBy: Types.ObjectId[];
  favoritedBy: Types.ObjectId[];
  negotiation?: {
    initialPrice: number;
    currentOffer: number;
    counterOffer?: number;
    status: 'pending' | 'accepted' | 'rejected' | 'expired' | 'completed';
    expiresAt?: Date;
  };
  payWhatYouWant?: {
    minimumPrice: number;
    maximumPrice?: number;
    proposedPrice?: number;
    status: 'pending' | 'accepted' | 'rejected';
  };
  offerHistory: IOfferHistory[];
  createdAt: Date;
  updatedAt: Date;
  __v?: number;
};

type Stringable = { toString(): string };

function listField(conversation: unknown, field: string): unknown[] | null {
  if (typeof conversation !== 'object' || conversation === null) return null;
  const value = (conversation as Record<string, unknown>)[field];
  return Array.isArray(value) ? value : null;
}

/**
 * Helper pour vérifier si offerHistory existe et est un array
 */
export function hasOfferHistory(conversation: unknown): conversation is { offerHistory: IOfferHistory[] } {
  return listField(conversation, 'offerHistory') !== null;
}

/**
 * Helper pour obtenir le nombre d'offres
 */
export function getOfferCount(conversation: unknown): number {
  return listField(conversation, 'offerHistory')?.length ?? 0;
}

/**
 * Helper pour vérifier si l'utilisateur a archivé la conversation
 */
export function isArchivedByUser(conversation: unknown, userId: string): boolean {
  const archivedBy = listField(conversation, 'archivedBy') as Stringable[] | null;
  return archivedBy?.some(id => id.toString() === userId) ?? false;
}

/**
 * Helper pour vérifier si l'utilisateur a mis la conversation en favoris
 */
export function isFavoritedByUser(conversation: unknown, userId: string): boolean {
  const favoritedBy = listField(conversation, 'favoritedBy') as Stringable[] | null;
  return favoritedBy?.some(id => id.toString() === userId) ?? false;
}

type OfferEntry = { amount?: number; offeredBy?: { _id?: Stringable } };

/**
 * Helper pour formater l'historique des offres
 */
export function formatOfferHistory(conversation: unknown, userId: string, currency: string = 'EUR') {
  const offers = listField(conversation, 'offerHistory') as OfferEntry[] | null;
  if (!offers) return [];

  return offers.map(offer => {
    const offeredById = offer.offeredBy?._id;
    return {
      ...offer,
      isCurrentUserOffer: offeredById ? offeredById.toString() === userId : false,
      formattedAmount: `${offer.amount} ${currency}`
    };
  });
}
