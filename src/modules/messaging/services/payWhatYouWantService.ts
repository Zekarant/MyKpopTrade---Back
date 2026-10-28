import { Types } from 'mongoose';
import Conversation from '../../../models/conversationModel';
import Product from '../../../models/productModel';
import { HttpError } from '../../../commons/utils/httpError';
import { initiateNegotiationFlow } from './conversationOfferService';

/** `enabled: false` (ou "false") désactive le prix libre ; absent, il est activé. */
function isDisableRequest(enabled: unknown): boolean {
  return enabled === false || enabled === 'false';
}

/**
 * Active (ou met à jour) le prix libre d'un produit. Les acheteurs proposent
 * ensuite leur prix par la négociation habituelle, bornée par cette fourchette ;
 * le prix accepté par le vendeur est celui facturé au paiement.
 * Avec `enabled: false`, le prix libre est retiré et la fourchette effacée.
 */
export async function initiatePayWhatYouWantFlow({
  userId,
  productId,
  minimumPrice,
  maximumPrice,
  enabled
}: {
  userId: string;
  productId: string;
  minimumPrice?: unknown;
  maximumPrice?: unknown;
  enabled?: unknown;
}) {
  if (!productId || !Types.ObjectId.isValid(productId)) {
    throw new HttpError(400, 'ID du produit requis');
  }

  if (isDisableRequest(enabled)) {
    const product = await Product.findOneAndUpdate(
      { _id: productId, seller: userId },
      { $set: { isPayWhatYouWant: false }, $unset: { pwywMinPrice: '', pwywMaxPrice: '' } },
      { returnDocument: 'after' }
    );
    if (!product) {
      throw new HttpError(404, 'Produit non trouvé ou vous n\'êtes pas le vendeur');
    }
    return {
      productId: product._id,
      enabled: false,
      minimumPrice: null,
      maximumPrice: null
    };
  }

  const min = parseFloat(minimumPrice as string);
  if (isNaN(min) || min < 0) {
    throw new HttpError(400, 'Prix minimum invalide');
  }

  const max = maximumPrice ? parseFloat(maximumPrice as string) : undefined;
  if (max !== undefined && (isNaN(max) || max <= min)) {
    throw new HttpError(400, 'Prix maximum invalide');
  }

  const product = await Product.findOneAndUpdate(
    { _id: productId, seller: userId },
    { $set: { isPayWhatYouWant: true, pwywMinPrice: min, pwywMaxPrice: max ?? null } },
    { returnDocument: 'after' }
  );
  if (!product) {
    throw new HttpError(404, 'Produit non trouvé ou vous n\'êtes pas le vendeur');
  }

  return {
    productId: product._id,
    enabled: true,
    minimumPrice: min,
    maximumPrice: max ?? null
  };
}

/**
 * Nouvelle proposition de prix libre depuis une conversation existante sur le
 * produit : même circuit qu'une offre de négociation.
 */
export async function makePayWhatYouWantProposalFlow({
  userId,
  conversationId,
  proposedPrice,
  message
}: {
  userId: string;
  conversationId: string;
  proposedPrice: unknown;
  message?: string;
}) {
  const price = parseFloat(proposedPrice as string);
  if (!proposedPrice || isNaN(price) || price <= 0) {
    throw new HttpError(400, 'Prix proposé invalide');
  }

  const conversation = await Conversation.findById(conversationId).select('productId').lean();
  if (!conversation?.productId) {
    throw new HttpError(404, 'Aucun produit associé à cette conversation');
  }

  const product = await Product.findById(conversation.productId).select('isPayWhatYouWant').lean();
  if (!product?.isPayWhatYouWant) {
    throw new HttpError(400, 'Ce produit n\'est pas proposé à prix libre');
  }

  return initiateNegotiationFlow({
    userId,
    productId: String(conversation.productId),
    initialOffer: price,
    message
  });
}
