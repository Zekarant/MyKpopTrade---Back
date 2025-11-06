import { IConversation, IOfferHistory } from '../../../models/conversationModel';
import mongoose from 'mongoose';

/**
 * Type pour les produits dans les conversations
 */
export type LeanProduct = {
  _id: any;
  title: string;
  description?: string;
  price: number;
  images: string[];
  seller: any;
  category?: string;
  condition?: string;
  kpopGroup?: string;
  kpopMember?: string;
  albumName?: string;
  currency: string;
  isAvailable: boolean;
  allowOffers?: boolean;
  minOfferPercentage?: number;
  shippingOptions?: any;
  createdAt: Date;
  categoryLabel?: string;
};

/**
 * Type helper pour les conversations avec lean()
 */
export type LeanConversation = {
  _id: any;
  participants: any[];
  productId?: LeanProduct;
  lastMessage?: any;
  lastMessageAt: Date;
  isActive: boolean;
  type: 'general' | 'product_inquiry' | 'negotiation' | 'pay_what_you_want';
  status: 'open' | 'closed' | 'archived';
  createdBy: any;
  title?: string;
  deletedBy: any[];
  archivedBy: any[];
  favoritedBy: any[];
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

/**
 * Helper pour typer une conversation récupérée avec lean()
 */
export function typeLeanConversation(conversation: any): LeanConversation {
  return conversation as LeanConversation;
}

/**
 * Helper pour vérifier si offerHistory existe et est un array
 */
export function hasOfferHistory(conversation: any): conversation is LeanConversation & { offerHistory: IOfferHistory[] } {
  return Array.isArray(conversation?.offerHistory);
}

/**
 * Helper pour obtenir le nombre d'offres
 */
export function getOfferCount(conversation: any): number {
  if (hasOfferHistory(conversation)) {
    return conversation.offerHistory.length;
  }
  return 0;
}

/**
 * Helper pour vérifier si l'utilisateur a archivé la conversation
 */
export function isArchivedByUser(conversation: any, userId: string): boolean {
  if (!Array.isArray(conversation?.archivedBy)) return false;
  return conversation.archivedBy.some((id: any) => id.toString() === userId);
}

/**
 * Helper pour vérifier si l'utilisateur a mis la conversation en favoris
 */
export function isFavoritedByUser(conversation: any, userId: string): boolean {
  if (!Array.isArray(conversation?.favoritedBy)) return false;
  return conversation.favoritedBy.some((id: any) => id.toString() === userId);
}

/**
 * Helper pour formater l'historique des offres
 */
export function formatOfferHistory(conversation: any, userId: string, currency: string = 'EUR'): any[] {
  if (!hasOfferHistory(conversation)) return [];
  
  return conversation.offerHistory.map((offer: any) => ({
    ...offer,
    isCurrentUserOffer: offer.offeredBy?._id 
      ? offer.offeredBy._id.toString() === userId 
      : false,
    formattedAmount: `${offer.amount} ${currency}`
  }));
}