import mongoose from 'mongoose';
import { type ReportTargetType } from '../../../models/reportModel';
import Rating from '../../../models/ratingModel';
import Product from '../../../models/productModel';
import Post from '../../../models/postModel';
import Message from '../../../models/messageModel';
import User from '../../../models/userModel';

const EXCERPT_LENGTH = 400;

export const excerpt = (value?: string): string =>
  !value ? '' : value.length <= EXCERPT_LENGTH ? value : `${value.slice(0, EXCERPT_LENGTH)}…`;

/** Cible d'un signalement en cours de création (existence, contrôle d'accès, résumé d'alerte). */
export async function findReportTarget(targetType: ReportTargetType, targetId: string) {
  if (targetType === 'rating') return Rating.findById(targetId).lean();
  if (targetType === 'product') return Product.findById(targetId).lean();
  if (targetType === 'post') return Post.findById(targetId).lean();
  if (targetType === 'message') return Message.findById(targetId).lean();
  return User.findById(targetId).lean();
}

type ReportTargetSummary = {
  _id?: unknown;
  title?: string;
  rating?: number;
  review?: string;
  content?: string;
  username?: string;
};

/** Résumé de la cible pour l'alerte admin. */
export const describeReportTarget = (targetType: string, target: ReportTargetSummary | null): string => {
  if (targetType === 'product') return target?.title || 'produit inconnu';
  if (targetType === 'rating') return `${target?.rating ?? '?'}/5 — ${excerpt(target?.review) || 'sans commentaire'}`;
  if (targetType === 'post') return excerpt(target?.content) || 'publication vide';
  if (targetType === 'user') return target?.username || 'profil inconnu';
  // L'alerte part vers un service tiers (Discord) : le contenu d'un message
  // privé n'y figure pas, il se lit dans le panneau d'administration.
  if (targetType === 'message') return 'message privé (contenu dans le panneau d\'administration)';
  return String(target?._id ?? 'cible inconnue');
};

const OWNER_FIELDS = 'username profilePicture accountStatus role isIdentityVerified';

async function loadUserTarget(targetId: mongoose.Types.ObjectId) {
  const user = await User.findById(targetId).select(`${OWNER_FIELDS} email bio location createdAt suspension`).lean();
  if (!user) return null;

  return {
    type: 'user',
    id: user._id,
    label: user.username,
    excerpt: user.bio || '',
    images: user.profilePicture ? [user.profilePicture] : [],
    owner: user,
    createdAt: user.createdAt,
    meta: { location: user.location, isSuspended: user.accountStatus === 'suspended' }
  };
}

async function loadPostTarget(targetId: mongoose.Types.ObjectId) {
  const post = await Post.findById(targetId)
    .select('content images isReply likesCount repliesCount author createdAt')
    .populate('author', OWNER_FIELDS)
    .lean();
  if (!post) return null;

  return {
    type: 'post',
    id: post._id,
    label: post.isReply ? 'Réponse' : 'Publication',
    excerpt: excerpt(post.content),
    images: post.images ?? [],
    owner: post.author,
    createdAt: post.createdAt,
    meta: { isReply: post.isReply, likesCount: post.likesCount, repliesCount: post.repliesCount }
  };
}

async function loadMessageTarget(targetId: mongoose.Types.ObjectId) {
  const message = await Message.findById(targetId)
    .select('content attachments isDeleted sender conversation createdAt')
    .populate('sender', OWNER_FIELDS)
    .lean();
  if (!message) return null;

  return {
    type: 'message',
    id: message._id,
    label: 'Message privé',
    // Texte complet : le modérateur juge sur ce qui a réellement été écrit.
    excerpt: message.content,
    // Les pièces jointes restent privées (servies aux seuls participants) : seul leur nombre est montré.
    images: [],
    owner: message.sender,
    createdAt: message.createdAt,
    meta: {
      conversationId: message.conversation,
      attachmentsCount: message.attachments?.length ?? 0,
      isDeleted: message.isDeleted
    }
  };
}

async function loadProductTarget(targetId: mongoose.Types.ObjectId) {
  const product = await Product.findById(targetId)
    .select('title description price currency images isAvailable isSold type condition seller createdAt')
    .populate('seller', OWNER_FIELDS)
    .lean();
  if (!product) return null;

  return {
    type: 'product',
    id: product._id,
    label: product.title,
    excerpt: excerpt(product.description),
    images: product.images ?? [],
    owner: product.seller,
    createdAt: product.createdAt,
    meta: {
      price: product.price,
      currency: product.currency,
      condition: product.condition,
      productType: product.type,
      isSold: product.isSold,
      isAvailable: product.isAvailable
    }
  };
}

async function loadRatingTarget(targetId: mongoose.Types.ObjectId) {
  const rating = await Rating.findById(targetId)
    .select('rating review images isHidden reviewer recipient createdAt')
    .populate('reviewer', OWNER_FIELDS)
    .populate('recipient', 'username profilePicture')
    .lean();
  if (!rating) return null;

  return {
    type: 'rating',
    id: rating._id,
    label: `Avis ${rating.rating}/5`,
    excerpt: excerpt(rating.review),
    images: rating.images ?? [],
    owner: rating.reviewer,
    createdAt: rating.createdAt,
    meta: {
      rating: rating.rating,
      isHidden: rating.isHidden,
      recipient: rating.recipient
    }
  };
}

const TARGET_LOADERS: Record<ReportTargetType, (targetId: mongoose.Types.ObjectId) => Promise<unknown>> = {
  user: loadUserTarget,
  post: loadPostTarget,
  message: loadMessageTarget,
  product: loadProductTarget,
  rating: loadRatingTarget
};

/** Vue de la cible pour le détail admin d'un signalement ; null si elle a disparu. */
export async function loadReportTargetView(targetType: ReportTargetType, targetId: mongoose.Types.ObjectId) {
  return TARGET_LOADERS[targetType](targetId);
}
