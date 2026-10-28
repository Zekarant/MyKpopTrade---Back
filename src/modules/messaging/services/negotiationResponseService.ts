import Conversation, { IOfferHistory } from '../../../models/conversationModel';
import Product, { IProduct } from '../../../models/productModel';
import { HttpError } from '../../../commons/utils/httpError';
import { createNotification } from '../../notifications/services/notificationService';
import { assertNotBlockedInConversation } from '../../users/services/userBlockService';
import {
  OFFER_STATUS,
  OFFER_TYPE,
  NEGOTIATION_CONVERSATION_TYPE,
  NegotiatedProduct,
  buildOfferEntry,
  setOfferHistoryStatus,
  findOfferConversation
} from './offerHistory';
import { MESSAGE_CONTENT_TYPE, MessageContentType, createOfferMessages } from './offerMessageService';

const NEGOTIATION_ACTIONS = ['accept', 'reject', 'counter'] as const;
type NegotiationAction = typeof NEGOTIATION_ACTIONS[number];

type ProductNegotiation = NonNullable<IProduct['negotiations']>[number];

type NegotiationActionResult = {
  statusMessage: string;
  contentType: MessageContentType;
};

const isNegotiationAction = (action: string): action is NegotiationAction =>
  (NEGOTIATION_ACTIONS as readonly string[]).includes(action);

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
  negotiation: ProductNegotiation,
  counter: { userId: string; product: NegotiatedProduct; amount: number; message?: string }
): Promise<NegotiationActionResult> {
  negotiation.counterOffer = counter.amount;
  negotiation.updatedAt = new Date();

  // MongoDB refuse $set sur 'offerHistory.$.status' + $push sur 'offerHistory'
  // dans la même updateOne (conflit sur le même path). On scinde en deux ops.
  await setOfferHistoryStatus(
    conversationId,
    pendingOffer._id,
    OFFER_STATUS.REJECTED,
    { 'negotiation.counterOffer': counter.amount }
  );

  await Conversation.updateOne(
    { _id: conversationId },
    { $push: { offerHistory: buildOfferEntry(counter.userId, counter.amount, OFFER_TYPE.COUNTER, counter.message) } }
  );

  return {
    statusMessage: `🔄 Contre-offre de ${counter.amount} ${counter.product.currency}`,
    contentType: MESSAGE_CONTENT_TYPE.COUNTER_OFFER
  };
}

function buildResponseNotification(
  action: NegotiationAction,
  { responder, product, offerAmount, counterOffer }: {
    responder: string;
    product: NegotiatedProduct;
    offerAmount: number;
    counterOffer?: number;
  }
) {
  switch (action) {
    case 'accept':
      return {
        type: 'offer_accepted',
        title: 'Offre acceptée',
        content: `${responder} a accepté votre offre de ${offerAmount} ${product.currency} sur "${product.title}"`
      };
    case 'reject':
      return {
        type: 'offer_rejected',
        title: 'Offre refusée',
        content: `${responder} a refusé votre offre sur "${product.title}"`
      };
    case 'counter':
      return {
        type: 'counter_offer',
        title: 'Contre-offre reçue',
        content: `${responder} propose ${counterOffer} ${product.currency} pour "${product.title}"`
      };
  }
}

/**
 * Accepte, refuse ou contre l'offre en attente d'une négociation. Le vendeur
 * répond aux offres de l'acheteur, l'acheteur aux contre-offres du vendeur.
 */
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
  if (!action || !isNegotiationAction(action)) {
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
  if (conversation.type !== NEGOTIATION_CONVERSATION_TYPE) {
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
      result = await applyCounterAction(conversationId, pendingOffer, negotiation, {
        userId, product, amount: counterOffer!, message
      });
      break;
  }

  negotiations[negotiationIndex] = negotiation;
  await productDoc.save();

  const optionalMsg = action !== 'reject' ? message : undefined;
  await createOfferMessages(conversationId, userId, result.statusMessage, result.contentType, optionalMsg);

  const offerAmount = pendingOffer.amount;
  // createNotification journalise déjà son échec ; la réponse à l'offre est enregistrée, elle ne doit pas échouer pour ça.
  await createNotification({
    recipientId: pendingOffer.offeredBy,
    ...buildResponseNotification(action, { responder, product, offerAmount, counterOffer }),
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
