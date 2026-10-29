import { Types } from 'mongoose';
import Conversation, { IConversation, IOfferHistory } from '../../../models/conversationModel';
import Product, { IProduct } from '../../../models/productModel';
import { verifyConversationAccess } from './messagingUtilsService';
import { LeanConversation } from '../types/conversationTypes';
import { HttpError } from '../../../commons/utils/httpError';
import { createNotification } from '../../notifications/services/notificationService';
import { assertNotBlocked } from '../../users/services/userBlockService';
import {
  OFFER_STATUS,
  OFFER_TYPE,
  NEGOTIATION_CONVERSATION_TYPE,
  NegotiatedProduct,
  buildOfferEntry,
  setOfferHistoryStatus,
  findOfferConversation
} from './offerHistory';
import { MESSAGE_CONTENT_TYPE, createOfferMessages } from './offerMessageService';

/**
 * Offres de négociation : ouverture (ou mise à jour), historique et annulation.
 * Les réponses aux offres sont dans negotiationResponseService, le prix libre
 * dans payWhatYouWantService.
 */

const DEFAULT_MIN_OFFER_PERCENTAGE = 50;
const DEFAULT_CURRENCY = 'EUR';

type OfferProduct = Pick<
  IProduct,
  | '_id' | 'seller' | 'title' | 'price' | 'currency' | 'isAvailable' | 'allowOffers' | 'minOfferPercentage'
  | 'isPayWhatYouWant' | 'pwywMinPrice' | 'pwywMaxPrice'
>;

function assertProductOfferable(product: OfferProduct | null, userId: string): asserts product is OfferProduct {
  if (!product) {
    throw new HttpError(404, 'Produit non trouvé');
  }
  if (!product.isAvailable) {
    throw new HttpError(400, 'Ce produit n\'est plus disponible');
  }
  if (!product.allowOffers && !product.isPayWhatYouWant) {
    throw new HttpError(400, 'Ce produit n\'accepte pas les offres');
  }
  if (product.seller.toString() === userId) {
    throw new HttpError(400, 'Vous ne pouvez pas faire une offre sur votre propre produit');
  }
}

/** Prix libre : la fourchette du vendeur remplace le pourcentage minimal d'offre. */
function assertOfferInAcceptedRange(product: OfferProduct, offer: number): void {
  if (product.isPayWhatYouWant) {
    const minimum = product.pwywMinPrice ?? 0;
    if (offer < minimum) {
      throw new HttpError(400, `Le prix proposé doit être au moins ${minimum} ${product.currency}`);
    }
    if (product.pwywMaxPrice && offer > product.pwywMaxPrice) {
      throw new HttpError(400, `Le prix proposé ne peut pas dépasser ${product.pwywMaxPrice} ${product.currency}`);
    }
    return;
  }

  const minPercentage = product.minOfferPercentage || DEFAULT_MIN_OFFER_PERCENTAGE;
  const minOffer = product.price * minPercentage / 100;
  if (offer < minOffer) {
    throw new HttpError(
      400,
      `L'offre doit être au moins ${minPercentage}% du prix (${minOffer} ${product.currency})`
    );
  }
}

async function updateExistingNegotiation(
  conversation: IConversation,
  userId: string,
  product: OfferProduct,
  initialOffer: number,
  message?: string
): Promise<{ oldOffer: number | null }> {
  const lastOffer = conversation.offerHistory.find(
    offer => offer.offeredBy.toString() === userId && offer.status === OFFER_STATUS.PENDING
  );

  const oldOffer = lastOffer ? lastOffer.amount : null;

  // La nouvelle offre remplace tout ce qui attendait une réponse, contre-offre
  // du vendeur comprise : sinon l'acceptation pourrait porter sur l'ancienne.
  await Conversation.updateOne(
    { _id: conversation._id },
    { $set: { 'offerHistory.$[pending].status': OFFER_STATUS.EXPIRED } },
    { arrayFilters: [{ 'pending.status': OFFER_STATUS.PENDING }] }
  );

  await Product.updateOne(
    { _id: product._id, 'negotiations.conversationId': conversation._id },
    {
      $set: {
        'negotiations.$.currentOffer': initialOffer,
        'negotiations.$.status': OFFER_STATUS.PENDING,
        'negotiations.$.updatedAt': new Date()
      },
      $unset: { 'negotiations.$.counterOffer': '' }
    }
  );

  await Conversation.updateOne(
    { _id: conversation._id },
    {
      $set: {
        'negotiation.currentOffer': initialOffer,
        'negotiation.status': OFFER_STATUS.PENDING,
        lastMessageAt: new Date()
      },
      $push: {
        offerHistory: buildOfferEntry(userId, initialOffer, OFFER_TYPE.INITIAL, message)
      }
    }
  );

  const systemContent = oldOffer
    ? `Offre mise à jour de ${oldOffer} ${product.currency} à ${initialOffer} ${product.currency}`
    : `Nouvelle offre de ${initialOffer} ${product.currency}`;

  await createOfferMessages(
    conversation._id,
    userId,
    systemContent,
    MESSAGE_CONTENT_TYPE.OFFER,
    message
  );

  return { oldOffer };
}

async function createNegotiationConversation(
  userId: string,
  product: OfferProduct,
  initialOffer: number,
  message?: string
) {
  const conversation = await Conversation.create({
    participants: [userId, product.seller],
    type: NEGOTIATION_CONVERSATION_TYPE,
    productId: product._id,
    createdBy: userId,
    status: 'open',
    negotiation: {
      initialPrice: product.price,
      currentOffer: initialOffer,
      status: OFFER_STATUS.PENDING
    },
    title: `Négociation pour ${product.title}`,
    offerHistory: [buildOfferEntry(userId, initialOffer, OFFER_TYPE.INITIAL, message)]
  });

  await createOfferMessages(
    conversation._id,
    userId,
    `Offre initiale de ${initialOffer} ${product.currency}`,
    MESSAGE_CONTENT_TYPE.OFFER,
    message
  );

  await Product.findByIdAndUpdate(
    product._id,
    {
      $push: {
        negotiations: {
          buyer: userId,
          initialOffer,
          currentOffer: initialOffer,
          status: OFFER_STATUS.PENDING,
          conversationId: conversation._id,
          createdAt: new Date(),
          updatedAt: new Date()
        }
      }
    }
  );

  return conversation;
}

/**
 * Ouvre une négociation sur un produit, ou met à jour l'offre de l'acheteur si
 * une négociation active existe déjà avec ce vendeur.
 */
export async function initiateNegotiationFlow({
  userId,
  productId,
  initialOffer,
  message
}: {
  userId: string;
  productId: string;
  initialOffer: number;
  message?: string;
}) {
  if (!productId || !initialOffer) {
    throw new HttpError(400, 'ID du produit et offre initiale requis');
  }
  if (typeof initialOffer !== 'number' || initialOffer <= 0) {
    throw new HttpError(400, 'L\'offre doit être un nombre positif');
  }

  const product = await Product.findById(productId);
  assertProductOfferable(product, userId);
  // Couvre aussi les propositions de prix libre, qui passent par ce même circuit.
  await assertNotBlocked(userId, product.seller);
  assertOfferInAcceptedRange(product, initialOffer);

  const existing = await Conversation.findOne({
    participants: { $all: [userId, product.seller] },
    productId: productId,
    type: NEGOTIATION_CONVERSATION_TYPE,
    isActive: true
  });

  let conversationId: Types.ObjectId;
  let isUpdatingOffer = false;
  let oldOffer: number | null = null;

  if (existing) {
    isUpdatingOffer = true;
    const result = await updateExistingNegotiation(existing, userId, product, initialOffer, message);
    oldOffer = result.oldOffer;
    conversationId = existing._id;
  } else {
    const created = await createNegotiationConversation(userId, product, initialOffer, message);
    conversationId = created._id;
  }

  const populatedConversation = await findOfferConversation(conversationId);

  // createNotification journalise déjà son échec ; l'offre est enregistrée, elle ne doit pas échouer pour ça.
  await createNotification({
    recipientId: product.seller,
    type: 'offer',
    title: isUpdatingOffer ? 'Offre mise à jour' : 'Nouvelle offre reçue',
    content: `${initialOffer} ${product.currency} pour "${product.title}"`,
    link: `/adherents/messages/${conversationId}`,
    data: { conversationId, productId: product._id, amount: initialOffer }
  });

  return {
    conversation: populatedConversation,
    initialOffer,
    isUpdate: isUpdatingOffer,
    previousOffer: oldOffer
  };
}

export async function fetchConversationOffers(userId: string, conversationId: string) {
  await verifyConversationAccess(conversationId, userId);

  const conversationRaw = await Conversation.findById(conversationId)
    .populate('offerHistory.offeredBy', 'username profilePicture')
    .populate({
      path: 'productId',
      select: 'title price images currency seller'
    })
    .lean();

  if (!conversationRaw) {
    throw new HttpError(404, 'Conversation non trouvée');
  }

  const conversation = conversationRaw as LeanConversation;

  const response: {
    conversationId: string;
    type: LeanConversation['type'];
    offerHistory: IOfferHistory[];
    currentNegotiation?: LeanConversation['negotiation'];
    product?: LeanConversation['productId'];
    isOwner?: boolean;
  } = {
    conversationId,
    type: conversation.type,
    offerHistory: conversation.offerHistory
  };

  if (conversation.type === NEGOTIATION_CONVERSATION_TYPE && conversation.negotiation) {
    response.currentNegotiation = {
      initialPrice: conversation.negotiation.initialPrice,
      currentOffer: conversation.negotiation.currentOffer,
      counterOffer: conversation.negotiation.counterOffer,
      status: conversation.negotiation.status,
      expiresAt: conversation.negotiation.expiresAt
    };
  }

  if (conversation.productId) {
    response.product = conversation.productId;
    response.isOwner = conversation.productId.seller.toString() === userId;
  }

  return response;
}

/** Retire l'offre en attente de l'utilisateur et l'annonce dans la conversation. */
export async function cancelOfferFlow(userId: string, conversationId: string) {
  const conversation = await Conversation.findById(conversationId).populate<{ productId: NegotiatedProduct | null }>({
    path: 'productId',
    select: 'title price currency seller'
  });

  if (!conversation) {
    throw new HttpError(404, 'Conversation non trouvée');
  }
  if (conversation.type !== NEGOTIATION_CONVERSATION_TYPE) {
    throw new HttpError(400, 'Cette conversation ne contient pas d\'offre');
  }

  const userOffer = conversation.offerHistory.find(
    offer => offer.offeredBy.toString() === userId && offer.status === OFFER_STATUS.PENDING
  );
  if (!userOffer) {
    throw new HttpError(404, 'Aucune offre en cours à annuler');
  }

  const product = conversation.productId;

  await setOfferHistoryStatus(
    conversationId,
    userOffer._id,
    OFFER_STATUS.EXPIRED,
    { 'offerHistory.$.respondedAt': new Date() }
  );

  if (conversation.negotiation) {
    await Conversation.updateOne(
      { _id: conversationId },
      { $set: { 'negotiation.status': OFFER_STATUS.EXPIRED } }
    );
  }

  await createOfferMessages(
    conversationId,
    userId,
    `Offre de ${userOffer.amount} ${product?.currency || DEFAULT_CURRENCY} annulée`,
    MESSAGE_CONTENT_TYPE.SYSTEM_NOTIFICATION
  );

  return {
    amount: userOffer.amount,
    cancelledAt: new Date()
  };
}
