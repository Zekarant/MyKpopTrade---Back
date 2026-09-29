import mongoose from 'mongoose';
import Conversation, { IConversation, IOfferHistory } from '../../../models/conversationModel';
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
  NEGOTIATION: 'negotiation'
} as const;

const CONVERSATION_FILTER = {
  UNREAD: 'unread',
  ARCHIVED: 'archived',
  FAVORITES: 'favorites',
  ACTIVE: 'active'
} as const;

const DEFAULT_CURRENCY = 'EUR';

/**
 * Champs publics des participants dans le détail d'une conversation : ceux du
 * profil public (badges, ancienneté, statistiques), jamais email, téléphone,
 * adresse ni données de paiement.
 */
const DETAIL_PARTICIPANT_FIELDS =
  'username profilePicture location bio preferences socialLinks statistics createdAt isIdentityVerified isSellerVerified';

type LastMessageSummary = {
  _id: mongoose.Types.ObjectId;
  content: string;
  contentType: string;
  sender: mongoose.Types.ObjectId | { _id: mongoose.Types.ObjectId; username: string };
  createdAt: Date;
  isEncrypted?: boolean;
};

type ListedConversation = Omit<LeanConversation, 'participants'> & {
  participants: { _id: mongoose.Types.ObjectId }[];
};

/**
 * Retourne la dernière offre pertinente de l'historique :
 * la plus récente acceptée si elle existe, sinon la toute dernière.
 */
function resolveLatestOffer(offerHistory: IOfferHistory[]): IOfferHistory | null {
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
    .populate('participants', DETAIL_PARTICIPANT_FIELDS)
    .populate({
      path: 'productId',
      select: 'title description price images seller category condition kpopGroup kpopMember albumName currency isAvailable allowOffers minOfferPercentage isPayWhatYouWant pwywMinPrice pwywMaxPrice shippingOptions createdAt'
    })
    .populate('offerHistory.offeredBy', 'username profilePicture')
    .lean();

  if (!conversationRaw) {
    throw new HttpError(404, 'Conversation non trouvée');
  }

  const conversation = conversationRaw as LeanConversation & {
    isOwner?: boolean;
    otherParticipant?: unknown;
    userMetadata?: { isArchived: boolean; isFavorited: boolean };
    formattedOfferHistory?: ReturnType<typeof formatOfferHistory>;
  };

  // Même règle que la liste : l'interlocuteur n'est défini qu'à deux participants.
  const participants = conversation.participants as unknown as { _id: mongoose.Types.ObjectId }[];
  conversation.otherParticipant = Array.isArray(participants) && participants.length === 2
    ? participants.find(p => p?._id?.toString() !== userId) ?? null
    : null;

  if (conversation.productId) {
    conversation.isOwner = conversation.productId.seller.toString() === userId;

    if (conversation.productId.category) {
      conversation.productId.categoryLabel = MessagingUtilsService.formatCategory(conversation.productId.category);
    }
  }

  conversation.userMetadata = {
    isArchived: isArchivedByUser(conversation, userId),
    isFavorited: isFavoritedByUser(conversation, userId)
  };

  if (Array.isArray(conversation.offerHistory) && conversation.offerHistory.length > 0) {
    conversation.formattedOfferHistory = formatOfferHistory(
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
    offersSummary: conversation.type === CONVERSATION_TYPE.NEGOTIATION ? {
      totalOffers: conversation.offerHistory.length,
      currentStatus: conversation.negotiation?.status,
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

/**
 * Messages non lus et dernier message de chaque conversation d'une page, en
 * deux requêtes. Le dernier message profite de l'index `{ conversation: 1, createdAt: -1 }`.
 */
async function loadConversationSummaries(conversationIds: unknown[], userId: string) {
  const unreadCounts = new Map<string, number>();
  const lastMessages = new Map<string, LastMessageSummary>();
  if (!conversationIds.length) return { unreadCounts, lastMessages };

  // Un pipeline d'agrégation ne convertit pas les types : ObjectId explicites.
  const ids = conversationIds.map((id) => new mongoose.Types.ObjectId(String(id)));
  const me = new mongoose.Types.ObjectId(userId);

  const [unread, latest] = await Promise.all([
    Message.aggregate<{ _id: mongoose.Types.ObjectId; count: number }>([
      { $match: { conversation: { $in: ids }, sender: { $ne: me }, readBy: { $ne: me }, isDeleted: false } },
      { $group: { _id: '$conversation', count: { $sum: 1 } } }
    ]),
    Message.aggregate<{ _id: mongoose.Types.ObjectId; message: LastMessageSummary }>([
      { $match: { conversation: { $in: ids }, isDeleted: false } },
      { $sort: { conversation: 1, createdAt: -1 } },
      {
        $group: {
          _id: '$conversation',
          message: {
            $first: {
              _id: '$_id',
              content: '$content',
              contentType: '$contentType',
              sender: '$sender',
              createdAt: '$createdAt',
              isEncrypted: '$isEncrypted'
            }
          }
        }
      }
    ])
  ]);

  const messages = latest.map((entry) => entry.message);
  await Message.populate(messages, { path: 'sender', select: 'username' });

  for (const entry of unread) unreadCounts.set(String(entry._id), entry.count);
  latest.forEach((entry, index) => lastMessages.set(String(entry._id), messages[index]));
  return { unreadCounts, lastMessages };
}

export async function listUserConversations(
  userId: string,
  page: number,
  limit: number,
  filter: string
) {
  const query: mongoose.QueryFilter<IConversation> = {
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

  const conversations = conversationsRaw as unknown as ListedConversation[];
  const { unreadCounts, lastMessages } = await loadConversationSummaries(
    conversations.map((conversation) => conversation._id),
    userId
  );

  const conversationsWithMetadata = conversations.map((conversation) => {
    const key = String(conversation._id);
    const unreadCount = unreadCounts.get(key) ?? 0;
    const lastMessage = lastMessages.get(key) ?? null;

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
        ? conversation.participants.find(p => p._id.toString() !== userId)
        : null,
      metadata: {
        isArchived: isArchivedByUser(conversation, userId),
        isFavorited: isFavoritedByUser(conversation, userId),
        hasActiveOffer,
        offerCount: Array.isArray(conversation.offerHistory) ? conversation.offerHistory.length : 0
      }
    };
  });

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
  type: IConversation['type'];
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

  const query: mongoose.QueryFilter<IConversation> = {
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
    .populate('participants', 'username profilePicture')
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
