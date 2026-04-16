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

/**
 * Crée un message système pour une action d'offre, puis un message texte optionnel,
 * et met à jour le champ lastMessage / lastMessageAt de la conversation.
 */
async function createOfferMessages(
  conversationId: any,
  senderId: string,
  systemContent: string,
  contentType: 'offer' | 'counter_offer' | 'system_notification',
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

  const minOffer = product.price * (product.minOfferPercentage || 50) / 100;
  if (initialOffer < minOffer) {
    throw new HttpError(
      400,
      `L'offre doit être au moins ${product.minOfferPercentage || 50}% du prix (${minOffer} ${product.currency})`
    );
  }

  let conversation = await Conversation.findOne({
    participants: { $all: [userId, product.seller] },
    productId: productId,
    type: 'negotiation',
    isActive: true
  });

  let isUpdatingOffer = false;
  let oldOffer: number | null = null;

  if (conversation) {
    isUpdatingOffer = true;

    const lastOffer = conversation.offerHistory.find(
      (offer: any) => offer.offeredBy.toString() === userId && offer.status === 'pending'
    );

    if (lastOffer) {
      oldOffer = lastOffer.amount;

      await Conversation.updateOne(
        {
          _id: conversation._id,
          'offerHistory._id': lastOffer._id
        },
        {
          $set: { 'offerHistory.$.status': 'expired' }
        }
      );
    }

    await Conversation.updateOne(
      { _id: conversation._id },
      {
        $set: {
          'negotiation.currentOffer': initialOffer,
          'negotiation.status': 'pending',
          lastMessageAt: new Date()
        },
        $push: {
          offerHistory: {
            offeredBy: userId,
            amount: initialOffer,
            offerType: 'initial',
            status: 'pending',
            message: message || '',
            createdAt: new Date()
          }
        }
      }
    );

    const systemContent = oldOffer
      ? `Offre mise à jour de ${oldOffer} ${product.currency} à ${initialOffer} ${product.currency}`
      : `Nouvelle offre de ${initialOffer} ${product.currency}`;

    await createOfferMessages(conversation._id, userId, systemContent, 'offer', message);
  } else {
    conversation = await Conversation.create({
      participants: [userId, product.seller],
      type: 'negotiation',
      productId: product._id,
      createdBy: userId,
      status: 'open',
      negotiation: {
        initialPrice: product.price,
        currentOffer: initialOffer,
        status: 'pending'
      },
      title: `Négociation pour ${product.title}`,
      offerHistory: [{
        offeredBy: userId,
        amount: initialOffer,
        offerType: 'initial',
        status: 'pending',
        message: message || '',
        createdAt: new Date()
      }]
    });

    await createOfferMessages(
      conversation._id,
      userId,
      `Offre initiale de ${initialOffer} ${product.currency}`,
      'offer',
      message
    );

    const negotiation = {
      buyer: userId,
      initialOffer,
      currentOffer: initialOffer,
      status: 'pending',
      conversationId: conversation._id,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    await Product.findByIdAndUpdate(
      productId,
      { $push: { negotiations: negotiation } }
    );
  }

  const populatedConversation = await Conversation.findById(conversation._id)
    .populate('participants', 'username profilePicture email')
    .populate('productId', 'title price images')
    .populate('lastMessage')
    .populate('offerHistory.offeredBy', 'username profilePicture');

  return {
    conversation: populatedConversation,
    initialOffer,
    isUpdate: isUpdatingOffer,
    previousOffer: oldOffer
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

  const conversation = await Conversation.findById(conversationId)
    .populate({
      path: 'productId',
      select: 'title price images seller negotiations currency'
    });

  if (!conversation) {
    throw new HttpError(404, 'Conversation non trouvée');
  }

  if (conversation.type !== 'negotiation') {
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
    (offer: any) => offer.status === 'pending'
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

  let statusMessage = '';
  let contentType: 'offer' | 'counter_offer' | 'system_notification' = 'system_notification';

  const offerAmount = pendingOffer.amount;

  switch (action) {
    case 'accept':
      negotiation.status = 'accepted';
      negotiation.currentOffer = offerAmount;
      statusMessage = `Offre de ${offerAmount} ${product.currency} acceptée`;

      await Conversation.updateOne(
        {
          _id: conversationId,
          'offerHistory._id': pendingOffer._id
        },
        {
          $set: {
            'negotiation.status': 'accepted',
            'negotiation.currentOffer': offerAmount,
            'offerHistory.$.status': 'accepted',
            'offerHistory.$.respondedAt': new Date()
          }
        }
      );
      break;

    case 'reject':
      negotiation.status = 'rejected';
      statusMessage = `Offre de ${offerAmount} ${product.currency} refusée`;

      if (message && message.trim()) {
        statusMessage += `\nRaison : ${message}`;
      }

      await Conversation.updateOne(
        {
          _id: conversationId,
          'offerHistory._id': pendingOffer._id
        },
        {
          $set: {
            'negotiation.status': 'rejected',
            'offerHistory.$.status': 'rejected',
            'offerHistory.$.respondedAt': new Date()
          }
        }
      );
      break;

    case 'counter':
      negotiation.counterOffer = counterOffer;
      negotiation.updatedAt = new Date();
      statusMessage = `🔄 Contre-offre de ${counterOffer} ${product.currency}`;
      contentType = 'counter_offer';

      // MongoDB refuse $set sur 'offerHistory.$.status' + $push sur 'offerHistory'
      // dans la même updateOne (conflit sur le même path). On scinde en deux ops.
      await Conversation.updateOne(
        {
          _id: conversationId,
          'offerHistory._id': pendingOffer._id
        },
        {
          $set: {
            'negotiation.counterOffer': counterOffer,
            'offerHistory.$.status': 'rejected'
          }
        }
      );

      await Conversation.updateOne(
        { _id: conversationId },
        {
          $push: {
            offerHistory: {
              offeredBy: userId,
              amount: counterOffer,
              offerType: 'counter',
              status: 'pending',
              message: message || '',
              createdAt: new Date()
            }
          }
        }
      );
      break;
  }

  productDoc.negotiations[negotiationIndex] = negotiation;
  await productDoc.save();

  const optionalMsg = action !== 'reject' ? message : undefined;
  await createOfferMessages(conversationId, userId, statusMessage, contentType, optionalMsg);

  const updatedConversation = await Conversation.findById(conversationId)
    .populate('participants', 'username profilePicture email')
    .populate('productId', 'title price images')
    .populate('lastMessage')
    .populate('offerHistory.offeredBy', 'username profilePicture');

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

  if (isNaN(parseFloat(minimumPrice as string)) || parseFloat(minimumPrice as string) < 0) {
    throw new HttpError(400, 'Prix minimum invalide');
  }

  if (
    maximumPrice &&
    (isNaN(parseFloat(maximumPrice as string)) ||
      parseFloat(maximumPrice as string) <= parseFloat(minimumPrice as string))
  ) {
    throw new HttpError(400, 'Prix maximum invalide');
  }

  try {
    const result = await startPayWhatYouWantFlow({
      productId,
      sellerId: userId,
      minimumPrice: parseFloat(minimumPrice as string),
      maximumPrice: maximumPrice ? parseFloat(maximumPrice as string) : undefined,
      message: message || ''
    });

    return result;
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
  if (
    !proposedPrice ||
    isNaN(parseFloat(proposedPrice as string)) ||
    parseFloat(proposedPrice as string) <= 0
  ) {
    throw new HttpError(400, 'Prix proposé invalide');
  }

  try {
    const result = await makePayWhatYouWantOfferFlow({
      conversationId,
      buyerId: userId,
      proposedPrice: parseFloat(proposedPrice as string),
      message: message || ''
    });

    return result;
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

  if (conversation.type === 'negotiation' && conversation.negotiation) {
    response.currentNegotiation = {
      initialPrice: conversation.negotiation.initialPrice,
      currentOffer: conversation.negotiation.currentOffer,
      counterOffer: conversation.negotiation.counterOffer,
      status: conversation.negotiation.status,
      expiresAt: conversation.negotiation.expiresAt
    };
  }

  if (conversation.type === 'pay_what_you_want' && conversation.payWhatYouWant) {
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
  const conversation = await Conversation.findById(conversationId)
    .populate({
      path: 'productId',
      select: 'title price currency seller'
    });

  if (!conversation) {
    throw new HttpError(404, 'Conversation non trouvée');
  }

  if (conversation.type !== 'negotiation' && conversation.type !== 'pay_what_you_want') {
    throw new HttpError(400, 'Cette conversation ne contient pas d\'offre');
  }

  const userOffer = conversation.offerHistory.find(
    (offer: any) => offer.offeredBy.toString() === userId && offer.status === 'pending'
  );

  if (!userOffer) {
    throw new HttpError(404, 'Aucune offre en cours à annuler');
  }

  const product = conversation.productId as any;

  await Conversation.updateOne(
    {
      _id: conversationId,
      'offerHistory._id': userOffer._id
    },
    {
      $set: {
        'offerHistory.$.status': 'expired',
        'offerHistory.$.respondedAt': new Date()
      }
    }
  );

  if (conversation.type === 'negotiation' && conversation.negotiation) {
    await Conversation.updateOne(
      { _id: conversationId },
      {
        $set: { 'negotiation.status': 'expired' }
      }
    );
  }

  if (conversation.type === 'pay_what_you_want' && conversation.payWhatYouWant) {
    await Conversation.updateOne(
      { _id: conversationId },
      {
        $set: { 'payWhatYouWant.status': 'rejected' }
      }
    );
  }

  const systemMessage = await Message.create({
    conversation: conversationId,
    sender: userId,
    content: `Offre de ${userOffer.amount} ${product?.currency || 'EUR'} annulée`,
    contentType: 'system_notification',
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
