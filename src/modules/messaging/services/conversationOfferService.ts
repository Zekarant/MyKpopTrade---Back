import Conversation from '../../../models/conversationModel';
import Message from '../../../models/messageModel';
import Product from '../../../models/productModel';
import { MessagingUtilsService } from './messagingUtilsService';
import {
  startPayWhatYouWant as startPayWhatYouWantFlow,
  makePayWhatYouWantOffer as makePayWhatYouWantOfferFlow
} from './negotiationService';
import { LeanConversation } from '../types/conversationTypes';
import { HttpError } from '../../../commons/utils/httpError';

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
  NEGOTIATION: 'negotiation',
  PAY_WHAT_YOU_WANT: 'pay_what_you_want'
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

/**
 * Crée un message système puis un message texte optionnel,
 * et met à jour lastMessage / lastMessageAt de la conversation.
 */
async function createOfferMessages(
  conversationId: any,
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

  let lastMessageId: any = systemMessage._id;

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
}

function populateOfferConversation(query: any) {
  return query
    .populate('participants', 'username profilePicture email')
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
  conversationId: any,
  offerId: any,
  status: typeof OFFER_STATUS[keyof typeof OFFER_STATUS],
  extraSet: Record<string, any> = {}
): Promise<void> {
  await Conversation.updateOne(
    { _id: conversationId, 'offerHistory._id': offerId },
    { $set: { 'offerHistory.$.status': status, ...extraSet } }
  );
}

function assertProductOfferable(product: any, userId: string): void {
  if (!product) {
    throw new HttpError(404, 'Produit non trouvé');
  }
  if (!product.isAvailable) {
    throw new HttpError(400, 'Ce produit n\'est plus disponible');
  }
  if (!product.allowOffers) {
    throw new HttpError(400, 'Ce produit n\'accepte pas les offres');
  }
  if (product.seller.toString() === userId) {
    throw new HttpError(400, 'Vous ne pouvez pas faire une offre sur votre propre produit');
  }
}

function assertOfferAboveMinimum(product: any, offer: number): void {
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
  conversation: any,
  userId: string,
  product: any,
  initialOffer: number,
  message?: string
): Promise<{ oldOffer: number | null }> {
  const lastOffer = conversation.offerHistory.find(
    (offer: any) => offer.offeredBy.toString() === userId && offer.status === OFFER_STATUS.PENDING
  );

  const oldOffer = lastOffer ? lastOffer.amount : null;

  if (lastOffer) {
    await setOfferHistoryStatus(conversation._id, lastOffer._id, OFFER_STATUS.EXPIRED);
  }

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
  product: any,
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
  assertOfferAboveMinimum(product, initialOffer);

  const existing = await Conversation.findOne({
    participants: { $all: [userId, product.seller] },
    productId: productId,
    type: CONVERSATION_TYPE.NEGOTIATION,
    isActive: true
  });

  let conversationId: any;
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

  const populatedConversation = await populateOfferConversation(Conversation.findById(conversationId));

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
  pendingOffer: any,
  product: any,
  negotiation: any
): Promise<NegotiationActionResult> {
  const offerAmount = pendingOffer.amount;
  negotiation.status = OFFER_STATUS.ACCEPTED;
  negotiation.currentOffer = offerAmount;

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
  pendingOffer: any,
  product: any,
  negotiation: any,
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
  pendingOffer: any,
  product: any,
  negotiation: any,
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

  const conversation = await Conversation.findById(conversationId).populate({
    path: 'productId',
    select: 'title price images seller negotiations currency'
  });

  if (!conversation) {
    throw new HttpError(404, 'Conversation non trouvée');
  }
  if (conversation.type !== CONVERSATION_TYPE.NEGOTIATION) {
    throw new HttpError(400, 'Cette conversation n\'est pas une négociation');
  }

  const product = conversation.productId as any;
  if (!product) {
    throw new HttpError(400, 'Produit non trouvé dans cette négociation');
  }
  if (product.seller.toString() !== userId) {
    throw new HttpError(403, 'Seul le vendeur peut répondre à cette offre');
  }

  const pendingOffer = conversation.offerHistory.find(
    (offer: any) => offer.status === OFFER_STATUS.PENDING
  );
  if (!pendingOffer) {
    throw new HttpError(404, 'Aucune offre en attente');
  }

  const productDoc = await Product.findById(product._id);
  const negotiationIndex = productDoc.negotiations.findIndex(
    (n: { conversationId: { toString(): string } }) => n.conversationId.toString() === conversationId
  );
  if (negotiationIndex === -1) {
    throw new HttpError(404, 'Négociation non trouvée pour ce produit');
  }
  const negotiation = productDoc.negotiations[negotiationIndex];

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

  productDoc.negotiations[negotiationIndex] = negotiation;
  await productDoc.save();

  const optionalMsg = action !== 'reject' ? message : undefined;
  await createOfferMessages(conversationId, userId, result.statusMessage, result.contentType, optionalMsg);

  const updatedConversation = await populateOfferConversation(Conversation.findById(conversationId));

  return {
    action,
    conversation: updatedConversation,
    negotiation: updatedConversation?.negotiation
  };
}

export async function initiatePayWhatYouWantFlow({
  userId,
  productId,
  minimumPrice,
  maximumPrice,
  message
}: {
  userId: string;
  productId: string;
  minimumPrice: unknown;
  maximumPrice?: unknown;
  message?: string;
}) {
  if (!productId) {
    throw new HttpError(400, 'ID du produit requis');
  }

  const min = parseFloat(minimumPrice as string);
  if (isNaN(min) || min < 0) {
    throw new HttpError(400, 'Prix minimum invalide');
  }

  const max = maximumPrice !== undefined ? parseFloat(maximumPrice as string) : undefined;
  if (maximumPrice && (isNaN(max!) || max! <= min)) {
    throw new HttpError(400, 'Prix maximum invalide');
  }

  try {
    return await startPayWhatYouWantFlow({
      productId,
      sellerId: userId,
      minimumPrice: min,
      maximumPrice: max,
      message: message || ''
    });
  } catch (error: any) {
    throw new HttpError(400, error.message);
  }
}

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

  try {
    return await makePayWhatYouWantOfferFlow({
      conversationId,
      buyerId: userId,
      proposedPrice: price,
      message: message || ''
    });
  } catch (error: any) {
    throw new HttpError(400, error.message);
  }
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

  const response: any = {
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

  if (conversation.type === CONVERSATION_TYPE.PAY_WHAT_YOU_WANT && conversation.payWhatYouWant) {
    response.payWhatYouWant = {
      minimumPrice: conversation.payWhatYouWant.minimumPrice,
      maximumPrice: conversation.payWhatYouWant.maximumPrice,
      proposedPrice: conversation.payWhatYouWant.proposedPrice,
      status: conversation.payWhatYouWant.status
    };
  }

  if (conversation.productId) {
    response.product = conversation.productId;
    response.isOwner = conversation.productId.seller.toString() === userId;
  }

  return response;
}

export async function cancelOfferFlow(userId: string, conversationId: string) {
  const conversation = await Conversation.findById(conversationId).populate({
    path: 'productId',
    select: 'title price currency seller'
  });

  if (!conversation) {
    throw new HttpError(404, 'Conversation non trouvée');
  }
  if (
    conversation.type !== CONVERSATION_TYPE.NEGOTIATION &&
    conversation.type !== CONVERSATION_TYPE.PAY_WHAT_YOU_WANT
  ) {
    throw new HttpError(400, 'Cette conversation ne contient pas d\'offre');
  }

  const userOffer = conversation.offerHistory.find(
    (offer: any) => offer.offeredBy.toString() === userId && offer.status === OFFER_STATUS.PENDING
  );
  if (!userOffer) {
    throw new HttpError(404, 'Aucune offre en cours à annuler');
  }

  const product = conversation.productId as any;

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

  if (conversation.type === CONVERSATION_TYPE.PAY_WHAT_YOU_WANT && conversation.payWhatYouWant) {
    await Conversation.updateOne(
      { _id: conversationId },
      { $set: { 'payWhatYouWant.status': OFFER_STATUS.REJECTED } }
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

  return {
    amount: userOffer.amount,
    cancelledAt: new Date()
  };
}
