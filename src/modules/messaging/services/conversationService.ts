import mongoose from 'mongoose';
import Conversation from '../../../models/conversationModel';
import Message from '../../../models/messageModel';
import User from '../../../models/userModel';
import Product from '../../../models/productModel';
import { MessagingUtilsService } from './messagingUtilsService';
import {
  LeanConversation,
  isArchivedByUser,
  isFavoritedByUser,
  formatOfferHistory
} from '../types/conversationTypes';
import { HttpError } from '../../../commons/utils/httpError';

export { HttpError };

const OFFER_STATUS = {
  PENDING: 'pending',
  ACCEPTED: 'accepted'
} as const;

const CONVERSATION_TYPE = {
  NEGOTIATION: 'negotiation',
  PAY_WHAT_YOU_WANT: 'pay_what_you_want'
} as const;

const CONVERSATION_FILTER = {
  UNREAD: 'unread',
  ARCHIVED: 'archived',
  FAVORITES: 'favorites',
  ACTIVE: 'active'
} as const;

const DEFAULT_CURRENCY = 'EUR';

/**
 * Retourne la dernière offre pertinente de l'historique :
 * la plus récente acceptée si elle existe, sinon la toute dernière.
 */
function resolveLatestOffer(offerHistory: any[]): any | null {
  if (!offerHistory.length) return null;
  const accepted = offerHistory.filter(o => o.status === OFFER_STATUS.ACCEPTED);
  return accepted.length > 0
    ? accepted[accepted.length - 1]
    : offerHistory[offerHistory.length - 1];
}

async function addUserToConversationField(
  conversationId: string,
  userId: string,
  field: 'archivedBy' | 'favoritedBy' | 'deletedBy'
) {
  const conversation = await Conversation.findByIdAndUpdate(
    conversationId,
    { $addToSet: { [field]: userId } },
    { new: true }
  );
  if (!conversation) {
    throw new HttpError(404, 'Conversation non trouvée');
  }
  return conversation;
}

async function removeUserFromConversationField(
  conversationId: string,
  userId: string,
  field: 'archivedBy' | 'favoritedBy'
) {
  const conversation = await Conversation.findByIdAndUpdate(
    conversationId,
    { $pull: { [field]: userId } },
    { new: true }
  );
  if (!conversation) {
    throw new HttpError(404, 'Conversation non trouvée');
  }
  return conversation;
}

export async function fetchConversation(
  conversationId: string,
  userId: string,
  page: number,
  limit: number
) {
  await MessagingUtilsService.verifyConversationAccess(conversationId, userId);

  const conversationRaw = await Conversation.findById(conversationId)
    .populate('participants', 'username profilePicture email location bio preferences socialLinks statistics')
    .populate({
      path: 'productId',
      select: 'title description price images seller category condition kpopGroup kpopMember albumName currency isAvailable allowOffers minOfferPercentage shippingOptions createdAt'
    })
    .populate('offerHistory.offeredBy', 'username profilePicture')
    .lean();

  if (!conversationRaw) {
    throw new HttpError(404, 'Conversation non trouvée');
  }

  const conversation = conversationRaw as LeanConversation;

  if (conversation.productId) {
    (conversation as any).isOwner = conversation.productId.seller.toString() === userId;

    if (conversation.productId.category) {
      conversation.productId.categoryLabel = MessagingUtilsService.formatCategory(conversation.productId.category);
    }
  }

  (conversation as any).userMetadata = {
    isArchived: isArchivedByUser(conversation, userId),
    isFavorited: isFavoritedByUser(conversation, userId)
  };

  if (Array.isArray(conversation.offerHistory) && conversation.offerHistory.length > 0) {
    (conversation as any).formattedOfferHistory = formatOfferHistory(
      conversation,
      userId,
      conversation.productId?.currency || DEFAULT_CURRENCY
    );
  }

  const messageQuery = {
    conversation: new mongoose.Types.ObjectId(conversationId),
    isDeleted: false,
    isActive: true
  };

  const totalMessages = await Message.countDocuments(messageQuery);

  const messages = await Message.find(messageQuery)
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .populate('sender', 'username profilePicture')
    .lean();

  const markedCount = await MessagingUtilsService.markConversationAsRead(conversationId, userId);

  const mediaQuery = {
    conversation: new mongoose.Types.ObjectId(conversationId),
    attachments: { $exists: true, $ne: [] },
    isDeleted: false
  };

  const mediaMessages = await Message.find(mediaQuery)
    .select('attachments createdAt sender')
    .populate('sender', 'username profilePicture')
    .sort({ createdAt: -1 })
    .lean();

  const media = MessagingUtilsService.formatConversationMedia(mediaMessages);

  return {
    conversation,
    messages,
    media,
    markedAsRead: markedCount,
    offersSummary: (
      conversation.type === CONVERSATION_TYPE.NEGOTIATION ||
      conversation.type === CONVERSATION_TYPE.PAY_WHAT_YOU_WANT
    ) ? {
      totalOffers: conversation.offerHistory.length,
      currentStatus: conversation.type === CONVERSATION_TYPE.NEGOTIATION
        ? conversation.negotiation?.status
        : conversation.payWhatYouWant?.status,
      latestOffer: resolveLatestOffer(conversation.offerHistory)
    } : null,
    pagination: {
      total: totalMessages,
      page,
      limit,
      pages: Math.ceil(totalMessages / limit)
    }
  };
}

export async function listUserConversations(
  userId: string,
  page: number,
  limit: number,
  filter: string
) {
  const query: any = {
    participants: userId,
    isActive: true,
    deletedBy: { $ne: userId }
  };

  if (filter === CONVERSATION_FILTER.UNREAD) {
    const conversationsWithUnreadMessages = await Message.distinct('conversation', {
      conversation: { $in: await Conversation.find({ participants: userId }).distinct('_id') },
      readBy: { $ne: userId },
      isDeleted: false
    });
    query._id = { $in: conversationsWithUnreadMessages };
  } else if (filter === CONVERSATION_FILTER.ARCHIVED) {
    query.archivedBy = userId;
  } else if (filter === CONVERSATION_FILTER.FAVORITES) {
    query.favoritedBy = userId;
  } else if (filter === CONVERSATION_FILTER.ACTIVE) {
    query.archivedBy = { $ne: userId };
  }

  const total = await Conversation.countDocuments(query);

  const conversationsRaw = await Conversation.find(query)
    .sort({ lastMessageAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .populate('participants', 'username profilePicture location bio preferences socialLinks statistics')
    .populate('productId', 'title price images currency')
    .lean();

  const conversations = conversationsRaw as LeanConversation[];

  const conversationsWithMetadata = await Promise.all(conversations.map(async (conversation) => {
    const unreadCount = await Message.countDocuments({
      conversation: conversation._id,
      sender: { $ne: userId },
      readBy: { $ne: userId },
      isDeleted: false
    });

    const lastMessage = await Message.findOne({
      conversation: conversation._id,
      isDeleted: false
    })
      .sort({ createdAt: -1 })
      .select('content contentType sender createdAt isEncrypted')
      .populate('sender', 'username')
      .lean();

    let messagePreview = '';
    if (lastMessage && !Array.isArray(lastMessage)) {
      messagePreview = MessagingUtilsService.generateMessagePreview(lastMessage);
    }

    const hasActiveOffer = conversation.type === CONVERSATION_TYPE.NEGOTIATION &&
      conversation.negotiation?.status === OFFER_STATUS.PENDING;

    return {
      ...conversation,
      unreadCount,
      lastMessage: lastMessage ? {
        ...lastMessage,
        preview: messagePreview
      } : null,
      otherParticipant: Array.isArray(conversation.participants) && conversation.participants.length === 2
        ? conversation.participants.find((p: any) => p._id.toString() !== userId)
        : null,
      metadata: {
        isArchived: isArchivedByUser(conversation, userId),
        isFavorited: isFavoritedByUser(conversation, userId),
        hasActiveOffer,
        offerCount: Array.isArray(conversation.offerHistory) ? conversation.offerHistory.length : 0
      }
    };
  }));

  return {
    conversations: conversationsWithMetadata,
    pagination: {
      total,
      page,
      limit,
      pages: Math.ceil(total / limit)
    }
  };
}

export async function createConversationForUser({
  userId,
  recipientId,
  productId,
  initialMessage,
  type
}: {
  userId: string;
  recipientId: string;
  productId?: string;
  initialMessage?: string;
  type: string;
}) {
  if (!recipientId) {
    throw new HttpError(400, 'Destinataire requis');
  }

  if (recipientId === userId) {
    throw new HttpError(400, 'Vous ne pouvez pas créer une conversation avec vous-même');
  }

  const recipient = await User.findById(recipientId);
  if (!recipient) {
    throw new HttpError(404, 'Destinataire non trouvé');
  }

  if (productId) {
    const product = await Product.findById(productId);
    if (!product) {
      throw new HttpError(404, 'Produit non trouvé');
    }
  }

  const query: any = {
    participants: { $all: [userId, recipientId] },
    type
  };

  if (productId) {
    query.productId = productId;
  }

  let conversation = await Conversation.findOne(query);

  if (!conversation) {
    const now = new Date();
    conversation = await Conversation.create({
      participants: [userId, recipientId],
      type,
      productId: productId || null,
      createdBy: userId,
      lastMessageAt: now
    });
  }

  if (initialMessage) {
    const message = await Message.create({
      conversation: conversation._id,
      sender: userId,
      content: initialMessage,
      contentType: 'text',
      readBy: [userId]
    });

    await Conversation.findByIdAndUpdate(
      conversation._id,
      {
        lastMessage: message._id,
        lastMessageAt: new Date()
      }
    );
  }

  return await Conversation.findById(conversation._id)
    .populate('participants', 'username profilePicture email')
    .populate('productId', 'title price images')
    .populate('lastMessage');
}

export async function fetchConversationMedia({
  userId,
  conversationId,
  page,
  limit,
  type
}: {
  userId: string;
  conversationId: string;
  page: number;
  limit: number;
  type?: string;
}) {
  await MessagingUtilsService.verifyConversationAccess(conversationId, userId);

  const mediaMessages = await Message.find({
    conversation: conversationId,
    attachments: { $exists: true, $ne: [] },
    isDeleted: false
  })
    .select('attachments createdAt sender')
    .populate('sender', 'username profilePicture')
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();

  let media = MessagingUtilsService.formatConversationMedia(mediaMessages);

  if (type && type !== 'all') {
    media = media.filter(item => item.type === type);
  }

  return {
    media,
    pagination: {
      total: media.length,
      page,
      limit,
      pages: Math.ceil(media.length / limit)
    }
  };
}

export async function softDeleteConversation(userId: string, conversationId: string) {
  await MessagingUtilsService.verifyConversationAccess(conversationId, userId);

  const conversation = await addUserToConversationField(conversationId, userId, 'deletedBy');

  if (conversation.deletedBy.length === conversation.participants.length) {
    await Conversation.findByIdAndUpdate(
      conversationId,
      { isActive: false, status: 'closed' }
    );
  }
}

export async function archiveConversationForUser(userId: string, conversationId: string) {
  await MessagingUtilsService.verifyConversationAccess(conversationId, userId);
  await addUserToConversationField(conversationId, userId, 'archivedBy');
}

export async function unarchiveConversationForUser(userId: string, conversationId: string) {
  await MessagingUtilsService.verifyConversationAccess(conversationId, userId);
  await removeUserFromConversationField(conversationId, userId, 'archivedBy');
}

export async function toggleFavoriteConversationForUser(userId: string, conversationId: string) {
  await MessagingUtilsService.verifyConversationAccess(conversationId, userId);

  const conversation = await Conversation.findById(conversationId);
  if (!conversation) {
    throw new HttpError(404, 'Conversation non trouvée');
  }

  const wasFavorited = conversation.favoritedBy.some(
    (id: mongoose.Types.ObjectId) => id.toString() === userId
  );

  if (wasFavorited) {
    await removeUserFromConversationField(conversationId, userId, 'favoritedBy');
  } else {
    await addUserToConversationField(conversationId, userId, 'favoritedBy');
  }

  return { wasFavorited };
}
