import { Types } from 'mongoose';
import Conversation, { IConversation, IOfferHistory } from '../../../models/conversationModel';
import Message from '../../../models/messageModel';
import Product, { IProduct } from '../../../models/productModel';
import { MessagingUtilsService } from './messagingUtilsService';
import { LeanConversation } from '../types/conversationTypes';
import { HttpError } from '../../../commons/utils/httpError';
import { NotificationService } from '../../notifications/services/notificationService';
import { assertNotBlocked, assertNotBlockedInConversation } from '../../users/services/userBlockService';
import { realtimePublisher } from '../../realtime/services/realtimePublisher';

const OFFER_STATUS = {
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
  EXPIRED: 'expired'
} as const;

const OFFER_TYPE = {
  INITIAL: 'initial',
  COUNTER: 'counter'
} as const;

const CONVERSATION_TYPE = {
  NEGOTIATION: 'negotiation'
} as const;

const MESSAGE_CONTENT_TYPE = {
  OFFER: 'offer',
  COUNTER_OFFER: 'counter_offer',
  SYSTEM_NOTIFICATION: 'system_notification'
} as const;

const DEFAULT_MIN_OFFER_PERCENTAGE = 50;

type MessageContentType =
  | typeof MESSAGE_CONTENT_TYPE.OFFER
  | typeof MESSAGE_CONTENT_TYPE.COUNTER_OFFER
  | typeof MESSAGE_CONTENT_TYPE.SYSTEM_NOTIFICATION;

type ObjectIdLike = Types.ObjectId | string;
type OfferProduct = Pick<
  IProduct,
  | '_id' | 'seller' | 'title' | 'price' | 'currency' | 'isAvailable' | 'allowOffers' | 'minOfferPercentage'
  | 'isPayWhatYouWant' | 'pwywMinPrice' | 'pwywMaxPrice'
>;
type NegotiatedProduct = Pick<IProduct, '_id' | 'seller' | 'title' | 'price' | 'currency'>;
type ProductNegotiation = NonNullable<IProduct['negotiations']>[number];

/**
 * Crée un message système puis un message texte optionnel,
 * et met à jour lastMessage / lastMessageAt de la conversation.
 */
async function createOfferMessages(
  conversationId: ObjectIdLike,
  senderId: string,
  systemContent: string,
  contentType: MessageContentType,
  optionalUserMessage?: string
): Promise<void> {
  const systemMessage = await Message.create({
    conversation: conversationId,
    sender: senderId,
    content: systemContent,
    contentType,
    isSystemMessage: true,
    readBy: [senderId]
  });

  let lastMessageId = systemMessage._id;

  if (optionalUserMessage && optionalUserMessage.trim()) {
    const userMessage = await Message.create({
      conversation: conversationId,
      sender: senderId,
      content: optionalUserMessage,
      contentType: 'text',
      readBy: [senderId]
    });
    lastMessageId = userMessage._id;
  }

  await Conversation.findByIdAndUpdate(
    conversationId,
    { lastMessage: lastMessageId, lastMessageAt: new Date() }
  );
  realtimePublisher.publishNewMessages(conversationId, [systemMessage._id, lastMessageId]);
}

function findOfferConversation(conversationId: ObjectIdLike) {
  return Conversation.findById(conversationId)
    .populate('participants', 'username profilePicture')
    .populate('productId', 'title price images')
    .populate('lastMessage')
    .populate('offerHistory.offeredBy', 'username profilePicture');
}

function buildOfferEntry(
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

async function setOfferHistoryStatus(
  conversationId: ObjectIdLike,
  offerId: Types.ObjectId,
  status: typeof OFFER_STATUS[keyof typeof OFFER_STATUS],
  extraSet: Record<string, unknown> = {}
): Promise<void> {
  await Conversation.updateOne(
    { _id: conversationId, 'offerHistory._id': offerId },
    { $set: { 'offerHistory.$.status': status, ...extraSet } }
  );
}

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
    type: CONVERSATION_TYPE.NEGOTIATION,
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
    type: CONVERSATION_TYPE.NEGOTIATION,
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

  await NotificationService.createNotification({
    recipientId: product.seller,
    type: 'offer',
    title: isUpdatingOffer ? 'Offre mise à jour' : 'Nouvelle offre reçue',
    content: `${initialOffer} ${product.currency} pour "${product.title}"`,
    link: `/adherents/messages/${conversationId}`,
    data: { conversationId, productId: product._id, amount: initialOffer }
  }).catch(() => undefined);

  return {
    conversation: populatedConversation,
    initialOffer,
    isUpdate: isUpdatingOffer,
    previousOffer: oldOffer
  };
}

type NegotiationActionResult = {
  statusMessage: string;
  contentType: MessageContentType;
};

async function applyAcceptAction(
  conversationId: string,
  pendingOffer: IOfferHistory,
  product: NegotiatedProduct,
  negotiation: ProductNegotiation
): Promise<NegotiationActionResult> {
  const offerAmount = pendingOffer.amount;
  negotiation.status = OFFER_STATUS.ACCEPTED;
  // currentOffer porte le montant accepté, celui que le paiement facture.
  negotiation.currentOffer = offerAmount;
  negotiation.counterOffer = undefined;
  negotiation.updatedAt = new Date();

  await setOfferHistoryStatus(
    conversationId,
    pendingOffer._id,
    OFFER_STATUS.ACCEPTED,
    {
      'negotiation.status': OFFER_STATUS.ACCEPTED,
      'negotiation.currentOffer': offerAmount,
      'offerHistory.$.respondedAt': new Date()
    }
  );

  return {
    statusMessage: `Offre de ${offerAmount} ${product.currency} acceptée`,
    contentType: MESSAGE_CONTENT_TYPE.SYSTEM_NOTIFICATION
  };
}

async function applyRejectAction(
  conversationId: string,
  pendingOffer: IOfferHistory,
  product: NegotiatedProduct,
  negotiation: ProductNegotiation,
  message?: string
): Promise<NegotiationActionResult> {
  const offerAmount = pendingOffer.amount;
  negotiation.status = OFFER_STATUS.REJECTED;

  await setOfferHistoryStatus(
    conversationId,
    pendingOffer._id,
    OFFER_STATUS.REJECTED,
    {
      'negotiation.status': OFFER_STATUS.REJECTED,
      'offerHistory.$.respondedAt': new Date()
    }
  );

  let statusMessage = `Offre de ${offerAmount} ${product.currency} refusée`;
  if (message && message.trim()) {
    statusMessage += `\nRaison : ${message}`;
  }

  return {
    statusMessage,
    contentType: MESSAGE_CONTENT_TYPE.SYSTEM_NOTIFICATION
  };
}

async function applyCounterAction(
  conversationId: string,
  pendingOffer: IOfferHistory,
  product: NegotiatedProduct,
  negotiation: ProductNegotiation,
  userId: string,
  counterOffer: number,
  message?: string
): Promise<NegotiationActionResult> {
  negotiation.counterOffer = counterOffer;
  negotiation.updatedAt = new Date();

  // MongoDB refuse $set sur 'offerHistory.$.status' + $push sur 'offerHistory'
  // dans la même updateOne (conflit sur le même path). On scinde en deux ops.
  await setOfferHistoryStatus(
    conversationId,
    pendingOffer._id,
    OFFER_STATUS.REJECTED,
    { 'negotiation.counterOffer': counterOffer }
  );

  await Conversation.updateOne(
    { _id: conversationId },
    { $push: { offerHistory: buildOfferEntry(userId, counterOffer, OFFER_TYPE.COUNTER, message) } }
  );

  return {
    statusMessage: `🔄 Contre-offre de ${counterOffer} ${product.currency}`,
    contentType: MESSAGE_CONTENT_TYPE.COUNTER_OFFER
  };
}

export async function respondToNegotiationFlow({
  userId,
  conversationId,
  action,
  counterOffer,
  message
}: {
  userId: string;
  conversationId: string;
  action: string;
  counterOffer?: number;
  message?: string;
}) {
  if (!action || !['accept', 'reject', 'counter'].includes(action)) {
    throw new HttpError(400, 'Action invalide. Doit être accept, reject ou counter');
  }
  if (action === 'counter' && (!counterOffer || typeof counterOffer !== 'number' || counterOffer <= 0)) {
    throw new HttpError(400, 'Contre-offre requise et doit être un nombre positif');
  }

  const conversation = await Conversation.findById(conversationId).populate<{ productId: NegotiatedProduct | null }>({
    path: 'productId',
    select: 'title price images seller currency'
  });

  if (!conversation) {
    throw new HttpError(404, 'Conversation non trouvée');
  }
  if (conversation.type !== CONVERSATION_TYPE.NEGOTIATION) {
    throw new HttpError(400, 'Cette conversation n\'est pas une négociation');
  }

  const product = conversation.productId;
  if (!product) {
    throw new HttpError(400, 'Produit non trouvé dans cette négociation');
  }
  if (!conversation.participants.some(participant => participant.toString() === userId)) {
    throw new HttpError(403, 'Vous ne participez pas à cette négociation');
  }
  // Accepter, refuser ou contrer écrit dans la conversation : refusé après un blocage.
  await assertNotBlockedInConversation(userId, conversation.participants);

  const pendingOffer = conversation.offerHistory
    .filter(offer => offer.status === OFFER_STATUS.PENDING)
    .pop();
  if (!pendingOffer) {
    throw new HttpError(404, 'Aucune offre en attente');
  }
  // Le vendeur répond aux offres de l'acheteur, l'acheteur aux contre-offres du vendeur.
  if (pendingOffer.offeredBy.toString() === userId) {
    throw new HttpError(403, 'Vous ne pouvez pas répondre à votre propre offre');
  }
  const responder = product.seller.toString() === userId ? 'Le vendeur' : 'L\'acheteur';

  const productDoc = await Product.findById(product._id).select('+negotiations');
  const negotiations = productDoc?.negotiations ?? [];
  const negotiationIndex = negotiations.findIndex(
    n => n.conversationId.toString() === conversationId
  );
  if (!productDoc || negotiationIndex === -1) {
    throw new HttpError(404, 'Négociation non trouvée pour ce produit');
  }
  const negotiation = negotiations[negotiationIndex];

  let result: NegotiationActionResult;
  switch (action) {
    case 'accept':
      result = await applyAcceptAction(conversationId, pendingOffer, product, negotiation);
      break;
    case 'reject':
      result = await applyRejectAction(conversationId, pendingOffer, product, negotiation, message);
      break;
    case 'counter':
      result = await applyCounterAction(
        conversationId, pendingOffer, product, negotiation, userId, counterOffer!, message
      );
      break;
    default:
      throw new HttpError(400, 'Action invalide');
  }

  negotiations[negotiationIndex] = negotiation;
  await productDoc.save();

  const optionalMsg = action !== 'reject' ? message : undefined;
  await createOfferMessages(conversationId, userId, result.statusMessage, result.contentType, optionalMsg);

  const offerAmount = pendingOffer.amount;
  const notification = {
    accept: {
      type: 'offer_accepted',
      title: 'Offre acceptée',
      content: `${responder} a accepté votre offre de ${offerAmount} ${product.currency} sur "${product.title}"`
    },
    reject: {
      type: 'offer_rejected',
      title: 'Offre refusée',
      content: `${responder} a refusé votre offre sur "${product.title}"`
    },
    counter: {
      type: 'counter_offer',
      title: 'Contre-offre reçue',
      content: `${responder} propose ${counterOffer} ${product.currency} pour "${product.title}"`
    }
  }[action as 'accept' | 'reject' | 'counter'];

  await NotificationService.createNotification({
    recipientId: pendingOffer.offeredBy,
    ...notification,
    link: `/adherents/messages/${conversationId}`,
    data: { conversationId, productId: product._id, action, amount: counterOffer || offerAmount }
  }).catch(() => undefined);

  const updatedConversation = await findOfferConversation(conversationId);

  return {
    action,
    conversation: updatedConversation,
    negotiation: updatedConversation?.negotiation
  };
}

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

  const conversation = await Conversation.findById(conversationId).select('productId');
  if (!conversation?.productId) {
    throw new HttpError(404, 'Aucun produit associé à cette conversation');
  }

  const product = await Product.findById(conversation.productId).select('isPayWhatYouWant');
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

export async function fetchConversationOffers(userId: string, conversationId: string) {
  await MessagingUtilsService.verifyConversationAccess(conversationId, userId);

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

  if (conversation.type === CONVERSATION_TYPE.NEGOTIATION && conversation.negotiation) {
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

export async function cancelOfferFlow(userId: string, conversationId: string) {
  const conversation = await Conversation.findById(conversationId).populate<{ productId: NegotiatedProduct | null }>({
    path: 'productId',
    select: 'title price currency seller'
  });

  if (!conversation) {
    throw new HttpError(404, 'Conversation non trouvée');
  }
  if (conversation.type !== CONVERSATION_TYPE.NEGOTIATION) {
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

  if (conversation.type === CONVERSATION_TYPE.NEGOTIATION && conversation.negotiation) {
    await Conversation.updateOne(
      { _id: conversationId },
      { $set: { 'negotiation.status': OFFER_STATUS.EXPIRED } }
    );
  }

  const systemMessage = await Message.create({
    conversation: conversationId,
    sender: userId,
    content: `Offre de ${userOffer.amount} ${product?.currency || 'EUR'} annulée`,
    contentType: MESSAGE_CONTENT_TYPE.SYSTEM_NOTIFICATION,
    isSystemMessage: true,
    readBy: [userId]
  });

  await Conversation.findByIdAndUpdate(
    conversationId,
    { lastMessage: systemMessage._id, lastMessageAt: new Date() }
  );
  realtimePublisher.publishNewMessages(conversationId, [systemMessage._id]);

  return {
    amount: userOffer.amount,
    cancelledAt: new Date()
  };
}
